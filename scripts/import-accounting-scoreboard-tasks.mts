/**
 * [Accounting Scoreboard: import the task boards from Carla's sheet]  2026-10-08, Open item 393 (plan Task 7 Step 7)
 * Reads every person tab of the "Accounting Scoreboard" sheet (read-only) and adds its tasks to that person's board.
 * Governing doc: docs/features/accounting-scoreboard-tasks.md § Importing from the sheet.
 *
 *   node --import tsx scripts/import-accounting-scoreboard-tasks.mts --sheet=<id>            # DRY RUN (default)
 *   node --import tsx scripts/import-accounting-scoreboard-tasks.mts --sheet=<id> --apply    # COMMIT
 *   node --import tsx scripts/import-accounting-scoreboard-tasks.mts --undo                  # DRY: what --undo --apply archives
 *   node --import tsx scripts/import-accounting-scoreboard-tasks.mts --undo --apply          # archive every live imported task
 *
 * The sheet id is not in this repo (the repo is public): it is in memory `carla-accounting-scoreboard-sheet`. Pass it
 * as --sheet=<id> or ACCOUNTING_SCOREBOARD_SHEET_ID. The HRIS service account reads it with spreadsheets.readonly.
 *
 * WHO EACH TAB BELONGS TO: a map file, never a guess at write time. The tab names are people's names, so the map lives
 * in docs/audits/backups/ (gitignored): accounting-scoreboard-task-tabs-map.json, { "<tab>": "<work email>" | "skip" }.
 * The first run writes a DRAFT: a tab whose name matches exactly one of the board's people (by their row label) is
 * proposed; every other tab is null. --apply REFUSES while any task tab is null, or names someone not on the board
 * (add them under Setup → Members first, or write "skip"). Names are never merged on similarity.
 *
 * WHAT IT WRITES: INSERTS into accounting_scoreboard_tasks only, created_by 'sheet-import', after the owner's existing
 * tasks. A task already live on that board (same frequency, same title, any case) is skipped, so a re-run adds nothing
 * twice. It reads TASKS, never ticks (the sheet's ticks are this week's state). A title with no checkbox beside it is a
 * heading or a note and is skipped (src/lib/accounting-scoreboard/task-import.ts, unit-tested).
 * Tasks are never deleted (the table refuses it), so --undo ARCHIVES every live task this import created.
 *
 * SAFE BY DEFAULT: no --apply = everything runs inside a transaction that is ALWAYS rolled back. A report (every tab,
 * every task, every skipped cell) is written to docs/audits/backups/ on every run.
 * Needs DATABASE_URL (the SESSION POOLER) and the tasks migration applied first
 * (scripts/apply-accounting-scoreboard-tasks-migration.mts). Do not double-click this file: Windows opens .mts as video.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import dotenv from 'dotenv';
import importModule from '../src/lib/accounting-scoreboard/task-import';
import authModule from '../src/lib/google-sheets/auth';
import type { ImportedTask, SheetGrid, SkippedCell } from '../src/lib/accounting-scoreboard/task-import';

// CJS interop: the repo's .mts scripts import src modules as a default export.
const { parseTaskTab } = importModule as unknown as typeof import('../src/lib/accounting-scoreboard/task-import');
const { getServiceAccountAccessToken } = authModule as unknown as typeof import('../src/lib/google-sheets/auth');

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
dotenv.config({ path: path.join(REPO_ROOT, '.env.local'), quiet: true });
dotenv.config({ quiet: true });

const STAMP = 'sheet-import';
const OUT_DIR = path.join(REPO_ROOT, 'docs', 'audits', 'backups');
const argv = process.argv.slice(2);
const arg = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? '';
const apply = argv.includes('--apply');
const undo = argv.includes('--undo');
const MAP_PATH = arg('map') || path.join(OUT_DIR, 'accounting-scoreboard-task-tabs-map.json');
const sheetId = (arg('sheet') || process.env.ACCOUNTING_SCOREBOARD_SHEET_ID || '').trim();
const runStamp = new Date().toISOString().replace(/[:.]/g, '-');

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error('DATABASE_URL is not set. Add the SESSION POOLER URI to .env.local (memory/migration-apply-needs-database-url).');
  process.exit(1);
}
if (!undo && !sheetId) {
  console.error('Pass the sheet id: --sheet=<id> (memory carla-accounting-scoreboard-sheet), or set ACCOUNTING_SCOREBOARD_SHEET_ID.');
  process.exit(1);
}

const client = new Client({ connectionString });

function writeOut(kind: string, body: unknown): string {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `accounting-scoreboard-task-import-${kind}-${runStamp}.json`);
  writeFileSync(file, JSON.stringify(body, null, 2));
  return path.relative(REPO_ROOT, file);
}

async function sheetsGet<T>(token: string, url: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(`Sheets ${res.status}: ${body.error?.message ?? ''}`);
  return body;
}

/** The board's people, the same three sources as listTaskPeople (server.ts), named by their row label. */
async function boardPeople(): Promise<Map<string, string>> {
  const r = await client.query<{ email: string; name: string | null; src: number }>(`
    SELECT lower(btrim(work_email)) AS email, label AS name, 1 AS src FROM public.accounting_scoreboard_rows
     WHERE archived_at IS NULL AND btrim(coalesce(work_email, '')) <> ''
    UNION ALL SELECT lower(btrim(work_email)), NULL, 2 FROM public.accounting_scoreboard_members WHERE removed_at IS NULL
    UNION ALL SELECT email, NULL, 3 FROM public.accounting_scoreboard_roles WHERE revoked_at IS NULL
    ORDER BY 3, 1`);
  const people = new Map<string, string>();
  for (const p of r.rows) if (!people.has(p.email)) people.set(p.email, (p.name ?? '').trim() || p.email.split('@')[0]);
  return people;
}

/** "FL Grace H." → "grace h" ; "Lenny T." → "lenny t". */
const norm = (s: string) => s.replace(/^FL\s+/i, '').replace(/\./g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Hints for an unmapped tab: board people whose label starts with the tab's first name. Printed, never written. */
function hints(tab: string, people: Map<string, string>): string[] {
  const first = norm(tab).split(' ')[0];
  return [...people].filter(([, name]) => norm(name).split(' ')[0] === first).map(([email]) => email);
}

function propose(tab: string, people: Map<string, string>): string | null {
  const t = norm(tab);
  const exact = [...people].filter(([, name]) => norm(name) === t);
  if (exact.length === 1) return exact[0][0];
  return null;
}

async function runUndo(): Promise<void> {
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — UNDO: archive every live task created by the sheet import\n`);
  await client.query('BEGIN');
  const live = await client.query<{ id: string; owner_email: string; frequency: string; title: string }>(
    `SELECT id, owner_email, frequency, title FROM public.accounting_scoreboard_tasks WHERE created_by = $1 AND archived_at IS NULL`,
    [STAMP],
  );
  const backup = writeOut('undo-backup', live.rows);
  console.log(`  ${live.rows.length} live imported task(s); backup → ${backup}`);
  const upd = await client.query(
    `UPDATE public.accounting_scoreboard_tasks SET archived_at = now(), archived_by = $2 WHERE created_by = $1 AND archived_at IS NULL`,
    [STAMP, `${STAMP}-undo`],
  );
  console.log(`  archived: ${upd.rowCount}`);
  if (apply) await client.query('COMMIT');
  else {
    await client.query('ROLLBACK');
    console.log('\nRolled back — production is unchanged. Re-run with --undo --apply to commit.');
  }
}

async function runImport(): Promise<void> {
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — import the task boards from the sheet's person tabs\n`);
  const ready = await client.query<{ ok: boolean }>(`SELECT to_regclass('public.accounting_scoreboard_tasks') IS NOT NULL AS ok`);
  const tableReady = Boolean(ready.rows[0]?.ok);
  if (!tableReady && apply) {
    console.error('accounting_scoreboard_tasks does not exist. Apply scripts/apply-accounting-scoreboard-tasks-migration.mts first.');
    process.exit(1);
  }
  if (!tableReady) console.log('The tasks table does not exist yet: PARSE ONLY (nothing is inserted, not even in the rolled-back transaction).\n');
  const people = await boardPeople();

  const token = await getServiceAccountAccessToken('https://www.googleapis.com/auth/spreadsheets.readonly');
  const meta = await sheetsGet<{ sheets: { properties: { title: string } }[] }>(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties(title)`,
  );
  const tabs: Array<{ tab: string; tasks: ImportedTask[]; skipped: SkippedCell[] }> = [];
  for (const { properties } of meta.sheets) {
    const tab = properties.title;
    if (/^copy of /i.test(tab) || /^task template$/i.test(tab)) continue;
    const range = encodeURIComponent(`'${tab}'!A1:Z200`);
    const body = await sheetsGet<{ values?: SheetGrid }>(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueRenderOption=FORMATTED_VALUE`,
    );
    const parsed = parseTaskTab(body.values ?? []);
    if (parsed.headerRow === null) continue;
    tabs.push({ tab, tasks: parsed.tasks, skipped: parsed.skipped });
  }

  // The map: read it, or draft it.
  let map: Record<string, string | null>;
  if (existsSync(MAP_PATH)) {
    map = JSON.parse(readFileSync(MAP_PATH, 'utf8')) as Record<string, string | null>;
  } else {
    map = Object.fromEntries(tabs.map((t) => [t.tab, propose(t.tab, people)]));
    mkdirSync(path.dirname(MAP_PATH), { recursive: true });
    writeFileSync(MAP_PATH, JSON.stringify(map, null, 2));
    console.log(`DRAFT map written (gitignored): ${path.relative(REPO_ROOT, MAP_PATH)}`);
    console.log('  Review it: each tab → a board person\'s work email, or "skip". null blocks --apply.\n');
  }

  const problems: string[] = [];
  for (const t of tabs) {
    const v = map[t.tab];
    if (v === undefined || v === null) problems.push(`"${t.tab}": not mapped yet`);
    else if (v !== 'skip' && !people.has(v.trim().toLowerCase())) problems.push(`"${t.tab}": ${v} is not on the board (Setup → Members first)`);
  }

  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '10s'");
  const existing = tableReady
    ? await client.query<{ owner_email: string; frequency: string; title: string; sort_order: number }>(
        `SELECT owner_email, frequency, title, sort_order FROM public.accounting_scoreboard_tasks WHERE archived_at IS NULL`,
      )
    : { rows: [] as Array<{ owner_email: string; frequency: string; title: string; sort_order: number }> };
  writeOut('existing-backup', existing.rows);
  const have = new Set(existing.rows.map((r) => `${r.owner_email}|${r.frequency}|${r.title.toLowerCase()}`));
  const nextOrder = new Map<string, number>();
  for (const r of existing.rows) nextOrder.set(r.owner_email, Math.max(nextOrder.get(r.owner_email) ?? -1, r.sort_order));

  const report: unknown[] = [];
  let inserted = 0;
  let already = 0;
  console.log('Tab → owner: tasks to add (per frequency) · already on the board · skipped cells');
  for (const t of tabs) {
    const v = map[t.tab];
    const owner = v && v !== 'skip' && people.has(v.trim().toLowerCase()) ? v.trim().toLowerCase() : null;
    const add = owner ? t.tasks.filter((k) => !have.has(`${owner}|${k.frequency}|${k.title.toLowerCase()}`)) : [];
    const dup = owner ? t.tasks.length - add.length : 0;
    const per = add.reduce<Record<string, number>>((acc, k) => ((acc[k.frequency] = (acc[k.frequency] ?? 0) + 1), acc), {});
    console.log(
      `  ${t.tab} → ${v === 'skip' ? 'SKIP' : owner ?? `UNMAPPED (${t.tasks.length} parsed; first-name matches: ${hints(t.tab, people).join(', ') || 'none'})`}: ${add.length} (${Object.entries(per).map(([f, n]) => `${f} ${n}`).join(', ') || '—'}) · ${dup} already · ${t.skipped.length} skipped`,
    );
    report.push({ tab: t.tab, owner: v ?? null, add, alreadyOnBoard: dup, skipped: t.skipped });
    if (!owner) continue;
    if (!tableReady) {
      inserted += add.length;
      already += dup;
      continue;
    }
    let order = nextOrder.get(owner) ?? -1;
    for (const k of add) {
      order += 1;
      await client.query(
        `INSERT INTO public.accounting_scoreboard_tasks (owner_email, title, frequency, sort_order, created_by) VALUES ($1, $2, $3, $4, $5)`,
        [owner, k.title, k.frequency, order, STAMP],
      );
      have.add(`${owner}|${k.frequency}|${k.title.toLowerCase()}`);
      inserted++;
    }
    already += dup;
    nextOrder.set(owner, order);
  }
  const reportPath = writeOut('report', report);
  console.log(`\n  ${inserted} task(s) to add, ${already} already on the board. Report → ${reportPath}`);

  if (problems.length) {
    console.log(`\n${problems.length} tab(s) block --apply:`);
    for (const p of problems) console.log(`  ${p}`);
  }
  if (apply && problems.length === 0) {
    await client.query('COMMIT');
    console.log('\nCommitted.');
  } else {
    await client.query('ROLLBACK');
    console.log(apply ? '\nRolled back: fix the map first — nothing was committed.' : '\nRolled back — production is unchanged. Re-run with --apply to commit.');
    if (apply) process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  await client.connect();
  try {
    if (undo) await runUndo();
    else await runImport();
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('\nFailed:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
