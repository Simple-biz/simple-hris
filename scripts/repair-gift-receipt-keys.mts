/**
 * [GIFT-RECEIPTS]
 * Move gift-receipt rows off a work email the roster does not use, onto the
 * master-list address the Gift Tracker actually looks up.
 *
 *   node --import tsx scripts/repair-gift-receipt-keys.mts            # REPORT ONLY (default)
 *   node --import tsx scripts/repair-gift-receipt-keys.mts --apply    # MOVE
 *
 * SAFE BY DEFAULT: no flag reads and reports. `--apply` is the only thing that
 * writes, and it writes a backup to disk first.
 *
 * WHY A MOVE AND NOT A RE-IMPORT
 * ------------------------------
 * Re-running the backfill with the fixed resolver would write the same facts
 * under the right key, but it would leave the orphaned rows behind as garbage
 * and it would restamp `recorded_at` and `recorded_by` on every row it touched.
 * An UPDATE preserves the provenance already on the row — when the assertion was
 * made, by whom, and out of which file — which is the whole reason those columns
 * are NOT NULL.
 *
 * WHAT IT REFUSES TO DO
 * ---------------------
 *  - **Ambiguity is a refusal.** If more than one master row could be the owner,
 *    nothing moves for that key. Merging two people's gift history is permanent
 *    and silent; an orphaned row is visible and recoverable.
 *  - **A collision is a refusal.** If the destination already holds a row for
 *    the same milestone_index, the move would either violate the unique key or
 *    (worse, if someone "fixed" that by deleting) overwrite a statement somebody
 *    made in the app. Those are reported for a human, never auto-merged.
 *  - **It never invents a match.** Resolution runs through the SHARED ladder in
 *    src/lib/gift-tracker/roster-match.ts — work email, then employee_id, then
 *    alternate work email, then name AND start date, every tier exact. No fuzzy
 *    matching: `lenny@`/`lennyt@` and `jo@`/`joe@` are the same edit distance
 *    apart, and one of those pairs is two different people.
 *
 * A HEALTHY KEY IS NOT "A KEY THE MASTER LIST HAS"
 * ------------------------------------------------
 * An earlier version skipped any key present in `global_master_list`. That called
 * a GHOST row healthy: `global_master_list` carries 216 rows absent from
 * `active_employees` with no off-board date, and two of them hold receipts for
 * people who are live at a different address (`teodya@` is Teody Amaro, active at
 * `james@`; `mat@` is Maria Fe Tanjusay, active at `maria@`). A key is healthy
 * only when the resolver agrees the rows are already where they belong.
 *
 * The identity evidence for each move comes from the source sheet (the employee
 * id, name and start date that row was imported with), so the CSV is required.
 *
 * Detector for the same class: scripts/audit-gift-receipt-key-drift.mts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import importModule from '../src/lib/gift-tracker/receipt-import';
import rosterMatchModule from '../src/lib/gift-tracker/roster-match';
import type { RosterPerson } from '../src/lib/gift-tracker/roster-match';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
dotenv.config({ path: path.join(REPO_ROOT, '.env.local') });
dotenv.config();

const { parseGiftReceiptCsv } =
  importModule as unknown as typeof import('../src/lib/gift-tracker/receipt-import');
const { buildRosterIndex, matchRosterPerson } =
  rosterMatchModule as unknown as typeof import('../src/lib/gift-tracker/roster-match');

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const apply = process.argv.includes('--apply');
const outDir = path.join(REPO_ROOT, argValue('--out') ?? 'reports');
const ACTOR = argValue('--actor') ?? 'kaner@simple.biz';
const csvPath = path.join(
  REPO_ROOT,
  argValue('--file') ??
    'references/docs/Work Anniversary Gift Tracker - Copy of HRIS Active Ppl.csv',
);

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local');
  process.exit(1);
}
if (!existsSync(csvPath)) {
  console.error(`CSV not found: ${csvPath}`);
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

type MasterRaw = {
  Name: string | null;
  'Work Email': string | null;
  'Personal Email': string | null;
  'Alternate Work Email': string | null;
  'Alternate Work Email 2': string | null;
  'Start Date': string | null;
  employee_id: string | null;
};
const MASTER_COLS =
  'Name,"Personal Email","Work Email","Alternate Work Email","Alternate Work Email 2","Start Date",employee_id';

async function pageMaster(table: string): Promise<MasterRaw[]> {
  const out: MasterRaw[] = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await sb
      .from(table)
      .select(MASTER_COLS)
      .order('Work Email', { ascending: true })
      .range(from, from + size - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as unknown as MasterRaw[];
    out.push(...rows);
    if (rows.length < size) break;
  }
  return out;
}

type ReceiptRow = Record<string, unknown> & {
  id: string;
  work_email: string;
  milestone_index: number;
  received: boolean;
};

async function pageReceipts(): Promise<ReceiptRow[]> {
  const out: ReceiptRow[] = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await sb
      .from('employee_gift_receipts')
      .select('*')
      .order('work_email', { ascending: true })
      .order('milestone_index', { ascending: true })
      .range(from, from + size - 1);
    if (error) throw new Error(`employee_gift_receipts: ${error.message}`);
    const rows = (data ?? []) as ReceiptRow[];
    out.push(...rows);
    if (rows.length < size) break;
  }
  return out;
}

async function main() {
  console.log(
    [
      `${apply ? 'APPLY' : 'REPORT ONLY'} — repair gift-receipt keys`,
      '',
      `  Actor   : ${ACTOR}`,
      `  Backups : ${outDir}`,
      '',
      apply
        ? '  Rows WILL be moved onto their master-list work email.'
        : '  Nothing will be written. Re-run with --apply to commit.',
      '',
    ].join('\n'),
  );

  const gml = await pageMaster('global_master_list');
  const active = await pageMaster('active_employees');
  const receipts = await pageReceipts();
  const { rows: csvRows } = parseGiftReceiptCsv(readFileSync(csvPath, 'utf8'));
  const csvByWork = new Map(csvRows.map((r) => [r.workEmail, r]));

  // The set of addresses the Gift Tracker will actually look receipts up under.
  // A key that is only in global_master_list is NOT healthy — it is a ghost, and
  // the person may be live elsewhere.
  const activeKeys = new Set<string>();
  for (const r of active) {
    const k = r['Work Email']?.trim().toLowerCase();
    if (k) activeKeys.add(k);
  }

  const toPerson = (r: MasterRaw, isActive: boolean): RosterPerson => ({
    name: r.Name,
    workEmail: r['Work Email'],
    personalEmail: r['Personal Email'],
    alternateWorkEmails: [r['Alternate Work Email'], r['Alternate Work Email 2']],
    startDate: r['Start Date'],
    employeeId: r.employee_id,
    isActive,
  });

  // EVERY row — never a Map keyed on work email, which would discard the
  // recycled-address collisions the resolver exists to report.
  const rosterIndex = buildRosterIndex([
    ...gml.map((r) => toPerson(r, false)),
    ...active.map((r) => toPerson(r, true)),
  ]);

  // Receipts grouped by their stored key, and the set of (key, milestone) pairs
  // that already exist — the collision check.
  const byKey = new Map<string, ReceiptRow[]>();
  const occupied = new Set<string>();
  for (const r of receipts) {
    const arr = byKey.get(r.work_email) ?? [];
    arr.push(r);
    byKey.set(r.work_email, arr);
    occupied.add(`${r.work_email}#${r.milestone_index}`);
  }

  const moves: Array<{ src: string; dst: string; via: string; name: string; rows: ReceiptRow[] }> = [];
  const refusals: Array<{ src: string; reason: string; detail: string }> = [];

  for (const [key, rows] of byKey) {
    const csv = csvByWork.get(key);
    const hit = matchRosterPerson(rosterIndex, {
      workEmail: key,
      name: csv?.name ?? null,
      startDate: csv?.startDateRaw ?? null,
      employeeId: csv?.employeeId ?? null,
    });

    // A key is healthy only when the resolver agrees it is where the rows
    // belong. Testing "is this key in the master list" instead would call a
    // GHOST row healthy — teodya@ and mat@ both have a master row and both
    // belong to someone who is live at a different address.
    if (hit.status === 'matched' && hit.key === key) continue;
    if (hit.status === 'unmatched' && activeKeys.has(key)) continue;

    if (hit.status === 'ambiguous') {
      refusals.push({
        src: key,
        reason: 'ambiguous',
        detail: `${hit.candidates.length} candidates via ${hit.method}: ${hit.candidates
          .map((c) => `${c.name} <${c.workEmail}>`)
          .join(' | ')}`,
      });
      continue;
    }
    if (hit.status === 'unmatched') {
      refusals.push({
        src: key,
        reason: 'unmatched',
        detail: csv
          ? `no master row matches ${csv.name} / ${csv.startDateRaw}`
          : 'this key is not in the source sheet, so there is no identity evidence',
      });
      continue;
    }

    const collisions = rows.filter((r) => occupied.has(`${hit.key}#${r.milestone_index}`));
    if (collisions.length > 0) {
      refusals.push({
        src: key,
        reason: 'collision',
        detail: `${hit.key} already holds milestone(s) ${collisions
          .map((r) => r.milestone_index)
          .join(', ')} — a human must reconcile these, they are NOT auto-merged`,
      });
      continue;
    }

    moves.push({
      src: key,
      dst: hit.key,
      via: hit.supersededStaleKey ? `${hit.method} (over the STALE row ${key})` : hit.method,
      name: csv?.name ?? (hit.person.name ?? ''),
      rows,
    });
  }

  const movedRowCount = moves.reduce((n, m) => n + m.rows.length, 0);
  console.log(
    [
      `Receipt rows on file: ${receipts.length} across ${byKey.size} keys`,
      `Keys not on any master address: ${moves.length + refusals.length}`,
      `  moves proposed : ${moves.length} keys / ${movedRowCount} rows`,
      `  REFUSED        : ${refusals.length}`,
      '',
    ].join('\n'),
  );

  for (const m of moves) {
    const state = m.rows
      .sort((a, b) => a.milestone_index - b.milestone_index)
      .map((r) => `${r.milestone_index}:${r.received ? 'Y' : 'N'}`)
      .join(' ');
    console.log(`  ${m.src.padEnd(26)} -> ${m.dst.padEnd(26)} via ${m.via.padEnd(22)} [${state}]  ${m.name}`);
  }
  if (refusals.length) {
    console.log('\nREFUSED (nothing moves for these):');
    for (const r of refusals) console.log(`  [${r.reason}] ${r.src} — ${r.detail}`);
  }
  console.log('');

  if (!apply) {
    console.log('REPORT ONLY — nothing was written. Re-run with --apply to commit.');
    return;
  }
  if (moves.length === 0) {
    console.log('Nothing to move.');
    return;
  }

  // ── Backup BEFORE any write, and read it back ────────────────────────────
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(outDir, `gift-receipt-rekey-backup-${stamp}.json`);
  const snapshot = moves.flatMap((m) => m.rows.map((r) => ({ ...r, __movingTo: m.dst, __via: m.via })));
  writeFileSync(backupPath, JSON.stringify(snapshot, null, 2), 'utf8');
  let verified = 0;
  try {
    verified = (JSON.parse(readFileSync(backupPath, 'utf8')) as unknown[]).length;
  } catch (e) {
    console.error(`Backup unreadable: ${(e as Error).message}\nABORTING — nothing moved.`);
    process.exit(1);
  }
  if (verified !== snapshot.length) {
    console.error(`Backup holds ${verified} of ${snapshot.length} rows. ABORTING — nothing moved.`);
    process.exit(1);
  }
  console.log(`Backup written and verified (${verified} rows): ${backupPath}`);

  // ── Trail FIRST, then the write ──────────────────────────────────────────
  const { error: auditError } = await sb.from('audit_log').insert({
    user_name: ACTOR,
    user_role: 'admin',
    action: 'gift_receipt.rekeyed',
    resource: 'employee_gift_receipts',
    resource_id: 'key-drift-repair',
    details: {
      reason:
        'Backfill matched on work_email alone; these rows were stored under an address the roster never looks up',
      moves: moves.map((m) => ({ src: m.src, dst: m.dst, via: m.via, rows: m.rows.length })),
      rows_moved: movedRowCount,
      refusals,
      backup_file: path.basename(backupPath),
      snapshot,
    },
  });
  if (auditError) {
    console.error(`Audit snapshot FAILED: ${auditError.message}\nABORTING — nothing moved.`);
    process.exit(1);
  }
  console.log('Audit snapshot written.');

  let moved = 0;
  for (const m of moves) {
    // The note names the address the row came from and the key that resolved
    // it. Without it the move is unauditable within a week: the row would look
    // like it had always been on this address.
    const { data, error } = await sb
      .from('employee_gift_receipts')
      .update({
        work_email: m.dst,
        note: `re-keyed 2026-09-11 from ${m.src} via ${m.via}`,
      })
      .eq('work_email', m.src)
      .select('id');
    if (error) {
      console.error(`\nMove ${m.src} -> ${m.dst} FAILED: ${error.message}`);
      console.error(`${moved} row(s) already moved. Backup: ${backupPath}`);
      process.exit(1);
    }
    moved += (data ?? []).length;
    console.log(`  moved ${(data ?? []).length} row(s): ${m.src} -> ${m.dst}`);
  }

  // ── Verify: nothing left behind, nothing lost ────────────────────────────
  const after = await pageReceipts();
  const stillOrphaned = after.filter((r) => !activeKeys.has(r.work_email));
  console.log(
    [
      '',
      `Moved ${moved} row(s).`,
      `Total receipts before ${receipts.length}, after ${after.length} (must be equal).`,
      `Rows not on an ACTIVE roster address (offboarded people included): ${stillOrphaned.length}`,
      `Backup retained at ${backupPath}`,
    ].join('\n'),
  );
  if (after.length !== receipts.length) {
    console.error('ROW COUNT CHANGED — investigate immediately, the backup has the originals.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\nFAILED:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
