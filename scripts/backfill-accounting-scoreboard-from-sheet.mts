/**
 * [Accounting Scoreboard backfill]
 * Fills the board's past weeks from Carla's "Accounting Scoreboard" Google Sheet, and keeps the
 * tab no section can hold in the archive. Governing doc: docs/features/accounting-scoreboard-backfill.md.
 *
 *   node --import tsx scripts/backfill-accounting-scoreboard-from-sheet.mts --sheet=<id>            # DRY RUN (default)
 *   node --import tsx scripts/backfill-accounting-scoreboard-from-sheet.mts --sheet=<id> --apply    # COMMIT
 *   node --import tsx scripts/backfill-accounting-scoreboard-from-sheet.mts --sheet=<id> --through=2026-09-26
 *   node --import tsx scripts/backfill-accounting-scoreboard-from-sheet.mts --undo                  # DRY: what --undo --apply removes
 *   node --import tsx scripts/backfill-accounting-scoreboard-from-sheet.mts --undo --apply          # remove everything this import wrote
 *
 * The sheet id is not in this repo (the repo is public): it is in memory
 * `carla-accounting-scoreboard-sheet`. Pass it as --sheet=<id> or ACCOUNTING_SCOREBOARD_SHEET_ID.
 * The HRIS service account reads it with spreadsheets.readonly.
 *
 * WHAT IT WRITES (all of it INSERTS, all stamped `sheet-import`, never an UPDATE)
 *   - "Collection Count" → accounting_scoreboard_collections, one line per sheet line.
 *   - "History"          → accounting_scoreboard_entries for Buckets, Inbox, PM Buckets and Sales
 *                          Onboarding, only for weeks that prove their own alignment
 *                          (src/lib/accounting-scoreboard/sheet-import.ts, unit-tested).
 *   - "Totals - History" → accounting_scoreboard_archive, row for row, as typed.
 *   - A sheet name with no board row of its own gets a new ARCHIVED row in that section: read-only,
 *     shown only for the weeks it has numbers in. Names are never merged on similarity.
 *
 * A DAY BELONGS TO THE SHEET OR TO THE BOARD, NEVER BOTH
 *   The default last day is the Saturday before the week of the first number anyone typed on the
 *   board, and a later --through is refused. On top of that, a collections day that already has a
 *   line (typed or imported, live or deleted), and a section-day that already has an entry, are
 *   skipped whole. So a re-run imports nothing twice and a typed number is never mixed with the sheet's.
 *
 * SAFE BY DEFAULT
 *   No --apply = everything runs inside a transaction that is ALWAYS rolled back, including the
 *   checks after the inserts. --apply commits only when every check passed. Before any write the
 *   current scoreboard tables are SELECTed to a backup file (CLAUDE.md § Data), and a full report
 *   (every skipped line, week and cell, with its reason) is written next to it. Both go to
 *   docs/audits/backups/ (gitignored: they hold names and business names).
 *
 * Needs DATABASE_URL (the SESSION POOLER, memory/migration-apply-needs-database-url) and, for the
 * archive, references/sql/create/2026-10-01_accounting_scoreboard_backfill.sql applied first.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import dotenv from 'dotenv';
import importModule from '../src/lib/accounting-scoreboard/sheet-import';
import weekModule from '../src/lib/accounting-scoreboard/week';
import sectionsModule from '../src/lib/accounting-scoreboard/sections';
import authModule from '../src/lib/google-sheets/auth';
import type { Cell, Grid, HistoryBlockParse, LabelledRow } from '../src/lib/accounting-scoreboard/sheet-import';
import type { SectionKey } from '../src/lib/accounting-scoreboard/sections';

// CJS interop: the repo's .mts scripts import src modules as a default export.
const { IMPORT_STAMP, HISTORY_BLOCKS, parseCollectionLog, parseHistoryBlock, parseArchiveTab, resolveRowLabel } =
  importModule as unknown as typeof import('../src/lib/accounting-scoreboard/sheet-import');
const { addDays, todayEastern, weekStartOf, weekdayOf } = weekModule as unknown as typeof import('../src/lib/accounting-scoreboard/week');
const { sectionDef, slotsFor } = sectionsModule as unknown as typeof import('../src/lib/accounting-scoreboard/sections');
const { getServiceAccountAccessToken } = authModule as unknown as typeof import('../src/lib/google-sheets/auth');

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
dotenv.config({ path: path.join(REPO_ROOT, '.env.local'), quiet: true });
dotenv.config({ quiet: true });

const TAB_LOG = 'Collection Count';
const TAB_HISTORY = 'History';
const TAB_ARCHIVE = 'Totals - History';

const arg = (name: string): string | null => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '';
};
const apply = arg('apply') !== null;
const undo = arg('undo') !== null;
const sheetId = (arg('sheet') || process.env.ACCOUNTING_SCOREBOARD_SHEET_ID || '').trim();
const throughArg = arg('through');
const outDir = path.resolve(REPO_ROOT, arg('out') || 'docs/audits/backups');

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error('DATABASE_URL is not set. Add the SESSION POOLER URI to .env.local (memory/migration-apply-needs-database-url).');
  process.exit(1);
}
if (!undo && !/^[A-Za-z0-9_-]{20,}$/.test(sheetId)) {
  console.error('Pass the sheet id: --sheet=<id> (memory carla-accounting-scoreboard-sheet), or set ACCOUNTING_SCOREBOARD_SHEET_ID.');
  process.exit(1);
}
if (throughArg !== null && !/^\d{4}-\d{2}-\d{2}$/.test(throughArg)) {
  console.error('--through must be YYYY-MM-DD.');
  process.exit(1);
}

const client = new Client({ connectionString });
const runStamp = new Date().toISOString().replace(/[:.]/g, '-');

function writeOut(kind: string, body: unknown): string {
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `accounting-scoreboard-backfill-${kind}-${runStamp}.json`);
  writeFileSync(file, JSON.stringify(body, null, 2));
  return path.relative(REPO_ROOT, file);
}

async function fetchTab(token: string, title: string, render: 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' | 'FORMULA'): Promise<Grid> {
  const range = encodeURIComponent(`'${title}'`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueRenderOption=${render}&dateTimeRenderOption=FORMATTED_STRING`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = (await res.json()) as { values?: Cell[][]; error?: { message?: string } };
  if (!res.ok) throw new Error(`Sheets ${title} (${render}): ${res.status} ${body.error?.message ?? ''}`);
  return body.values ?? [];
}

async function insertMany(table: string, cols: string[], rows: unknown[][], casts: Record<string, string> = {}): Promise<void> {
  const BATCH = 1000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const params: unknown[] = [];
    const tuples = rows.slice(i, i + BATCH).map(
      (r) =>
        `(${r
          .map((v, k) => {
            params.push(v);
            return `$${params.length}${casts[cols[k]] ? `::${casts[cols[k]]}` : ''}`;
          })
          .join(', ')})`,
    );
    await client.query(`INSERT INTO public.${table} (${cols.join(', ')}) VALUES ${tuples.join(', ')}`, params);
  }
}

type RowRec = { id: string; section_key: SectionKey; label: string; work_email: string | null; sort_order: number; archived_at: string | null; created_by: string };
type EntryRec = { row_id: string; entry_date: string; slot: string; value: string; updated_by: string };
type CollRec = { id: string; entry_date: string; row_id: string; business_name: string; points: string; amount_usd: string | null; created_by: string; deleted_at: string | null };

let failed = 0;
function check(ok: boolean, label: string, detail = ''): void {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

async function snapshot() {
  const rows = (await client.query<RowRec>(`SELECT id, section_key, label, work_email, sort_order, archived_at, created_by, created_at FROM public.accounting_scoreboard_rows`)).rows;
  const entries = (
    await client.query<EntryRec>(`SELECT row_id, to_char(entry_date, 'YYYY-MM-DD') AS entry_date, slot, value::text, updated_by, updated_at FROM public.accounting_scoreboard_entries`)
  ).rows;
  const collections = (
    await client.query<CollRec>(
      `SELECT id, to_char(entry_date, 'YYYY-MM-DD') AS entry_date, row_id, business_name, points::text, amount_usd::text, created_by, created_at, deleted_at, deleted_by FROM public.accounting_scoreboard_collections`,
    )
  ).rows;
  const hasArchive = (await client.query<{ ok: boolean }>(`SELECT to_regclass('public.accounting_scoreboard_archive') IS NOT NULL AS ok`)).rows[0].ok;
  const archive = hasArchive
    ? (await client.query<{ tab: string; sheet_row: number; imported_by: string }>(`SELECT tab, sheet_row, imported_by, imported_at FROM public.accounting_scoreboard_archive`)).rows
    : null;
  return { rows, entries, collections, archive, hasArchive };
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

async function runUndo(): Promise<void> {
  console.log(`${apply ? 'UNDO (COMMIT)' : 'UNDO DRY RUN'} — remove every row stamped '${IMPORT_STAMP}'\n`);
  await client.connect();
  await client.query('BEGIN');
  const snap = await snapshot();
  const backup = writeOut('undo-backup', {
    stamp: IMPORT_STAMP,
    rows: snap.rows.filter((r) => r.created_by === IMPORT_STAMP),
    entries: snap.entries.filter((e) => e.updated_by === IMPORT_STAMP),
    collections: snap.collections.filter((c) => c.created_by === IMPORT_STAMP),
    archive: (snap.archive ?? []).filter((a) => a.imported_by === IMPORT_STAMP),
  });
  console.log(`  backup: ${backup}`);
  const del = async (sql: string) => (await client.query(sql, [IMPORT_STAMP])).rowCount ?? 0;
  const nColl = await del(`DELETE FROM public.accounting_scoreboard_collections WHERE created_by = $1`);
  const nEntries = await del(`DELETE FROM public.accounting_scoreboard_entries WHERE updated_by = $1`);
  // Only rows nothing points at any more. An imported number someone has since edited keeps its row.
  const nRows = await del(
    `DELETE FROM public.accounting_scoreboard_rows r WHERE r.created_by = $1
       AND NOT EXISTS (SELECT 1 FROM public.accounting_scoreboard_collections c WHERE c.row_id = r.id)
       AND NOT EXISTS (SELECT 1 FROM public.accounting_scoreboard_entries e WHERE e.row_id = r.id)`,
  );
  const nArchive = snap.hasArchive ? await del(`DELETE FROM public.accounting_scoreboard_archive WHERE imported_by = $1`) : 0;
  console.log(`  collections ${nColl} · entries ${nEntries} · rows ${nRows} · archive ${nArchive}`);
  if (apply) {
    await client.query('COMMIT');
    console.log('\nCommitted.');
  } else {
    await client.query('ROLLBACK');
    console.log('\nRolled back — nothing removed. Re-run with --undo --apply to commit.');
  }
  await client.end();
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

async function runImport(): Promise<void> {
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — Accounting Scoreboard backfill from the sheet\n`);

  console.log('Reading the sheet (read-only)…');
  const token = await getServiceAccountAccessToken('https://www.googleapis.com/auth/spreadsheets.readonly');
  const [logGrid, histValues, histFormulas, archiveGrid] = await Promise.all([
    fetchTab(token, TAB_LOG, 'FORMATTED_VALUE'),
    fetchTab(token, TAB_HISTORY, 'UNFORMATTED_VALUE'),
    fetchTab(token, TAB_HISTORY, 'FORMULA'),
    fetchTab(token, TAB_ARCHIVE, 'FORMATTED_VALUE'),
  ]);
  const log = parseCollectionLog(logGrid);
  const history: HistoryBlockParse[] = HISTORY_BLOCKS.map((spec) => parseHistoryBlock(histValues, histFormulas, spec));
  const archiveRows = parseArchiveTab(archiveGrid);
  console.log(`  ${TAB_LOG}: ${log.lines.length} lines (${log.skipped.length} skipped) · ${TAB_HISTORY}: ${history.map((h) => `${h.spec.section} ${h.cells.length}`).join(', ')} cells · ${TAB_ARCHIVE}: ${archiveRows.length} rows\n`);

  await client.connect();
  await client.query('BEGIN');
  const snap = await snapshot();
  const backup = writeOut('backup', { takenAt: new Date().toISOString(), rows: snap.rows, entries: snap.entries, collections: snap.collections, archive: snap.archive });
  console.log(`Backup of the current tables: ${backup}`);

  // --- the cut-off: a day belongs to the sheet or the board, never both ---
  const typed = [
    ...snap.entries.filter((e) => e.updated_by !== IMPORT_STAMP).map((e) => e.entry_date),
    ...snap.collections.filter((c) => c.created_by !== IMPORT_STAMP).map((c) => c.entry_date),
  ].sort();
  const firstTyped = typed[0] ?? null;
  const latestThrough = addDays(weekStartOf(firstTyped ?? todayEastern()), -1);
  if (throughArg && throughArg > latestThrough) {
    console.error(`\n--through=${throughArg} is refused: the board has typed numbers from ${firstTyped}, so the last day the sheet may fill is ${latestThrough}.`);
    await client.query('ROLLBACK');
    await client.end();
    process.exit(1);
  }
  const through = throughArg ?? latestThrough;
  console.log(`Importing through ${through} (first typed number on the board: ${firstTyped ?? 'none'})\n`);

  // --- rows ---
  const sectionRows = new Map<SectionKey, LabelledRow[]>();
  const maxSort = new Map<SectionKey, number>();
  for (const r of snap.rows) {
    const list = sectionRows.get(r.section_key) ?? [];
    list.push({ id: r.id, label: r.label, archived: r.archived_at !== null });
    sectionRows.set(r.section_key, list);
    maxSort.set(r.section_key, Math.max(maxSort.get(r.section_key) ?? 0, r.sort_order));
  }
  const newRows: Array<{ id: string; section: SectionKey; label: string; sortOrder: number }> = [];
  const refusedLabels: Array<{ section: SectionKey; label: string; reason: string }> = [];
  function rowFor(section: SectionKey, sheetLabel: string): string | null {
    const list = sectionRows.get(section) ?? [];
    const hit = resolveRowLabel(sheetLabel, list);
    if (hit) return hit.id;
    const label = sheetLabel.trim();
    if (label.length < 1 || label.length > 80) {
      if (!refusedLabels.some((r) => r.section === section && r.label === label)) {
        refusedLabels.push({ section, label, reason: 'a row label is 1–80 characters' });
      }
      return null;
    }
    const sortOrder = (maxSort.get(section) ?? 0) + 1;
    maxSort.set(section, sortOrder);
    const id = randomUUID();
    newRows.push({ id, section, label, sortOrder });
    list.push({ id, label, archived: true });
    sectionRows.set(section, list);
    return id;
  }
  const sectionOfRow = new Map(snap.rows.map((r) => [r.id, r.section_key]));

  // --- collections ---
  const takenCollectionDays = new Set(snap.collections.map((c) => c.entry_date));
  const plannedColl: Array<{ date: string; rowId: string; businessName: string; points: number; amountUsd: number | null; sheetRow: number }> = [];
  const collDaysSkipped = new Map<string, number>();
  let collAfterThrough = 0;
  for (const line of log.lines) {
    if (line.date > through) {
      collAfterThrough++;
      continue;
    }
    if (takenCollectionDays.has(line.date)) {
      collDaysSkipped.set(line.date, (collDaysSkipped.get(line.date) ?? 0) + 1);
      continue;
    }
    const rowId = rowFor('collections', line.rep);
    if (!rowId) continue;
    plannedColl.push({ date: line.date, rowId, businessName: line.businessName, points: line.points, amountUsd: line.amountUsd, sheetRow: line.sheetRow });
  }

  // --- entries ---
  const takenSectionDays = new Set(snap.entries.map((e) => `${sectionOfRow.get(e.row_id)}|${e.entry_date}`));
  const plannedEntries = new Map<string, { rowId: string; section: SectionKey; date: string; slot: string; value: number }>();
  const conflicts: Array<{ section: SectionKey; label: string; date: string; slot: string; values: number[] }> = [];
  const conflicted = new Set<string>();
  const entryDaysSkipped = new Map<string, number>();
  const refusedCells: Array<{ section: SectionKey; label: string; date: string; slot: string; reason: string }> = [];
  let entriesAfterThrough = 0;
  for (const block of history) {
    const def = sectionDef(block.spec.section);
    for (const c of block.cells) {
      if (c.date > through) {
        entriesAfterThrough++;
        continue;
      }
      const dayKey = `${c.section}|${c.date}`;
      if (takenSectionDays.has(dayKey)) {
        entryDaysSkipped.set(dayKey, (entryDaysSkipped.get(dayKey) ?? 0) + 1);
        continue;
      }
      if (!slotsFor(c.section).includes(c.slot) || !def.days.includes(weekdayOf(c.date))) {
        refusedCells.push({ section: c.section, label: c.label, date: c.date, slot: c.slot, reason: 'the section does not keep that slot or day' });
        continue;
      }
      const rowId = rowFor(c.section, c.label);
      if (!rowId) continue;
      const key = `${rowId}|${c.date}|${c.slot}`;
      if (conflicted.has(key)) continue;
      const prior = plannedEntries.get(key);
      if (prior && prior.value !== c.value) {
        // Two sheet rows that land on one board row disagree: neither number is written.
        conflicts.push({ section: c.section, label: c.label, date: c.date, slot: c.slot, values: [prior.value, c.value] });
        plannedEntries.delete(key);
        conflicted.add(key);
        continue;
      }
      plannedEntries.set(key, { rowId, section: c.section, date: c.date, slot: c.slot, value: c.value });
    }
  }

  // --- archive ---
  const archiveTaken = (snap.archive ?? []).some((a) => a.tab === TAB_ARCHIVE);
  const plannedArchive = snap.hasArchive && !archiveTaken ? archiveRows : [];

  // --- write (inside the transaction) ---
  console.log('Writing (inside the transaction)…');
  const now = new Date().toISOString();
  await insertMany(
    'accounting_scoreboard_rows',
    ['id', 'section_key', 'label', 'sort_order', 'created_by', 'archived_at', 'archived_by'],
    newRows.map((r) => [r.id, r.section, r.label, r.sortOrder, IMPORT_STAMP, now, IMPORT_STAMP]),
  );
  await insertMany(
    'accounting_scoreboard_collections',
    ['entry_date', 'row_id', 'business_name', 'points', 'amount_usd', 'created_by'],
    plannedColl.map((c) => [c.date, c.rowId, c.businessName, c.points, c.amountUsd, IMPORT_STAMP]),
  );
  const entryList = [...plannedEntries.values()];
  await insertMany(
    'accounting_scoreboard_entries',
    ['row_id', 'entry_date', 'slot', 'value', 'updated_by'],
    entryList.map((e) => [e.rowId, e.date, e.slot, e.value, IMPORT_STAMP]),
  );
  await insertMany(
    'accounting_scoreboard_archive',
    ['tab', 'sheet_row', 'cells', 'entry_date', 'imported_by'],
    plannedArchive.map((a) => [TAB_ARCHIVE, a.sheetRow, JSON.stringify(a.cells), a.entryDate, IMPORT_STAMP]),
    { cells: 'jsonb' },
  );

  // --- checks, read back from the database inside the same transaction ---
  console.log('\nChecks (read back inside the transaction):');
  const count = async (sql: string, params: unknown[] = []) => Number((await client.query<{ n: string }>(sql, params)).rows[0].n);
  const priorStampColl = snap.collections.filter((c) => c.created_by === IMPORT_STAMP).length;
  const priorStampEntries = snap.entries.filter((e) => e.updated_by === IMPORT_STAMP).length;
  const priorStampRows = snap.rows.filter((r) => r.created_by === IMPORT_STAMP).length;
  check(
    (await count(`SELECT count(*) AS n FROM public.accounting_scoreboard_collections WHERE created_by = $1`, [IMPORT_STAMP])) === priorStampColl + plannedColl.length,
    `${plannedColl.length} collections lines landed`,
  );
  check(
    (await count(`SELECT count(*) AS n FROM public.accounting_scoreboard_entries WHERE updated_by = $1`, [IMPORT_STAMP])) === priorStampEntries + entryList.length,
    `${entryList.length} entries landed`,
  );
  check(
    (await count(`SELECT count(*) AS n FROM public.accounting_scoreboard_rows WHERE created_by = $1 AND archived_at IS NOT NULL`, [IMPORT_STAMP])) === priorStampRows + newRows.length,
    `${newRows.length} new rows landed, every one archived`,
  );
  if (snap.hasArchive) {
    check(
      (await count(`SELECT count(*) AS n FROM public.accounting_scoreboard_archive WHERE tab = $1`, [TAB_ARCHIVE])) === (archiveTaken ? snap.archive!.filter((a) => a.tab === TAB_ARCHIVE).length : plannedArchive.length),
      `${TAB_ARCHIVE}: ${plannedArchive.length} archive rows landed${archiveTaken ? ' (already archived, none added)' : ''}`,
    );
  }
  const typedAfter = await count(
    `SELECT count(*) AS n FROM public.accounting_scoreboard_entries WHERE updated_by <> $1`,
    [IMPORT_STAMP],
  );
  check(typedAfter === snap.entries.filter((e) => e.updated_by !== IMPORT_STAMP).length, 'no typed entry was touched');
  check(
    (await count(`SELECT count(*) AS n FROM public.accounting_scoreboard_collections WHERE created_by <> $1`, [IMPORT_STAMP])) ===
      snap.collections.filter((c) => c.created_by !== IMPORT_STAMP).length,
    'no typed collection was touched',
  );
  check(
    (await count(
      `SELECT count(*) AS n FROM public.accounting_scoreboard_collections WHERE created_by = $1 AND (entry_date > $2 OR extract(dow FROM entry_date) IN (0, 6))`,
      [IMPORT_STAMP, through],
    )) === 0,
    `every imported line is a weekday on or before ${through}`,
  );
  check(
    (await count(
      `SELECT count(*) AS n FROM public.accounting_scoreboard_entries WHERE updated_by = $1 AND (entry_date > $2 OR extract(dow FROM entry_date) IN (0, 6))`,
      [IMPORT_STAMP, through],
    )) === 0,
    `every imported entry is a weekday on or before ${through}`,
  );

  // Week by week, the log's points read back equal the sheet's.
  const planWeeks = new Map<string, number>();
  for (const c of plannedColl) planWeeks.set(weekStartOf(c.date), (planWeeks.get(weekStartOf(c.date)) ?? 0) + c.points);
  const dbWeeks = new Map(
    (
      await client.query<{ week_start: string; points: string }>(
        `SELECT to_char(entry_date - extract(dow FROM entry_date)::int, 'YYYY-MM-DD') AS week_start, sum(points)::text AS points
           FROM public.accounting_scoreboard_collections WHERE created_by = $1 AND deleted_at IS NULL GROUP BY 1`,
        [IMPORT_STAMP],
      )
    ).rows.map((r) => [r.week_start, Number(r.points)]),
  );
  const weekMismatch = [...planWeeks].filter(([w, p]) => dbWeeks.get(w) !== p);
  check(weekMismatch.length === 0, `points per week match the sheet for all ${planWeeks.size} weeks`, weekMismatch.slice(0, 3).map(([w]) => w).join(', '));

  // The view the board now reads gives the same record as the raw log.
  const viewOk = (await client.query<{ ok: boolean }>(`SELECT to_regclass('public.accounting_scoreboard_collection_weeks') IS NOT NULL AS ok`)).rows[0].ok;
  let record: { week_start: string; points: number } | null = null;
  if (viewOk) {
    const top = (
      await client.query<{ week_start: string; points: string }>(
        `SELECT to_char(week_start, 'YYYY-MM-DD') AS week_start, sum(points)::text AS points FROM public.accounting_scoreboard_collection_weeks GROUP BY week_start ORDER BY sum(points) DESC, week_start LIMIT 1`,
      )
    ).rows[0];
    record = top ? { week_start: top.week_start, points: Number(top.points) } : null;
    const rawTop = [...dbWeeks].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    check(!rawTop || (record?.points ?? -1) >= rawTop[1], `the weekly view's record (${record?.points ?? '—'} points, week of ${record?.week_start ?? '—'}) is at least the imported best week`);
  }

  // Section-day by section-day, the entries read back equal the plan.
  const planDays = new Map<string, number>();
  for (const e of entryList) planDays.set(`${e.section}|${e.date}`, (planDays.get(`${e.section}|${e.date}`) ?? 0) + 1);
  const dbDays = new Map(
    (
      await client.query<{ k: string; n: string }>(
        `SELECT r.section_key || '|' || to_char(e.entry_date, 'YYYY-MM-DD') AS k, count(*)::text AS n
           FROM public.accounting_scoreboard_entries e JOIN public.accounting_scoreboard_rows r ON r.id = e.row_id
          WHERE e.updated_by = $1 GROUP BY 1`,
        [IMPORT_STAMP],
      )
    ).rows.map((r) => [r.k, Number(r.n)]),
  );
  // A planned section-day held no entry before (takenSectionDays), so it now holds exactly the plan.
  const dayMismatch = [...planDays].filter(([k, n]) => dbDays.get(k) !== n);
  check(dayMismatch.length === 0, `entries per section-day match the plan for all ${planDays.size} section-days`);

  // --- report ---
  const reportFile = writeOut('report', {
    mode: apply ? 'apply' : 'dry-run',
    through,
    firstTyped,
    counts: {
      collections: plannedColl.length,
      collectionsPoints: plannedColl.reduce((a, c) => a + c.points, 0),
      collectionsAfterThrough: collAfterThrough,
      entries: entryList.length,
      entriesAfterThrough,
      newArchivedRows: newRows.length,
      archiveRows: plannedArchive.length,
    },
    record,
    skippedLogLines: log.skipped,
    amountNotes: log.amountNotes,
    collectionDaysSkippedBecauseTheBoardHasThem: Object.fromEntries(collDaysSkipped),
    entryDaysSkippedBecauseTheBoardHasThem: Object.fromEntries(entryDaysSkipped),
    historyWeeks: history.flatMap((h) => h.weeks),
    skippedCells: history.flatMap((h) => h.skippedCells),
    unlabelledRows: Object.fromEntries(history.map((h) => [h.spec.section, h.unlabelledRows])),
    conflicts,
    refusedLabels,
    refusedCells,
    newRows: newRows.map((r) => ({ section: r.section, label: r.label })),
    archive: { tab: TAB_ARCHIVE, alreadyArchived: archiveTaken, tableExists: snap.hasArchive },
  });

  console.log('\nSummary:');
  console.log(`  collections   ${plannedColl.length} lines, ${plannedColl.reduce((a, c) => a + c.points, 0)} points, ${planWeeks.size} weeks (${log.skipped.length} sheet lines skipped, ${log.amountNotes.length} amounts dropped)`);
  for (const h of history) {
    const imported = h.weeks.filter((w) => w.imported).length;
    const n = entryList.filter((e) => e.section === h.spec.section).length;
    console.log(`  ${h.spec.section.padEnd(13)} ${n} entries, ${imported} of ${h.weeks.length} History weeks proved their alignment`);
  }
  console.log(`  rows          ${newRows.length} new archived rows · ${conflicts.length} conflicting cells dropped · ${refusedLabels.length} labels refused`);
  console.log(`  archive       ${snap.hasArchive ? `${plannedArchive.length} rows of "${TAB_ARCHIVE}"${archiveTaken ? ' (already archived)' : ''}` : 'SKIPPED: apply references/sql/create/2026-10-01_accounting_scoreboard_backfill.sql first'}`);
  console.log(`  report        ${reportFile}`);

  if (apply && failed === 0) {
    await client.query('COMMIT');
    console.log('\nAll checks passed — committed.');
  } else {
    await client.query('ROLLBACK');
    console.log(failed ? `\n${failed} check(s) failed — rolled back, nothing written.` : '\nDry run — rolled back, production is unchanged. Re-run with --apply to commit.');
  }
  await client.end();
  if (failed) process.exit(1);
}

(undo ? runUndo() : runImport()).catch(async (e) => {
  console.error('\nFailed:', e instanceof Error ? e.message : String(e));
  try {
    await client.query('ROLLBACK');
  } catch {
    /* not in a transaction */
  }
  try {
    await client.end();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
