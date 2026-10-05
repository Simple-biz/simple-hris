/**
 * Backfill: put every past orientation no-show on the Offboarded list.
 *
 *   node --import tsx scripts/backfill-noshow-offboarded.mts           # DRY RUN — reports, writes nothing
 *   node --import tsx scripts/backfill-noshow-offboarded.mts --apply   # backup, insert, read back
 *
 * Until 2026-10-05 Manager → Did not attend never wrote `offboarded_sheet`, so
 * 42 of 59 no-shows were missing from both Offboarded lists and HR nearly
 * re-interviewed a returning one (audit item 343). The route now writes the row
 * itself; this fills in the ones marked before that.
 *
 * Same row as the route, by construction: both call `buildNoShowLedgerRow`
 * (`src/lib/hr/no-show-ledger.ts`) — reason `ncns`, origin `hris`, the no-show's
 * own date and marker, the work email WITHHELD when a live master row carries it.
 *
 * INSERT-ONLY, and safe to re-run:
 *   - a pending hire whose `(pending hire #id)` marker is already on the ledger is
 *     skipped — that is the route's row, or this script's from an earlier run;
 *   - a no-show already recorded under ANY reason is skipped: a ledger row, or a
 *     row planned earlier in this run, on the same personal email dated within 3
 *     days. Reason-agnostic on purpose: HR filed #439 as `Withdrawn` the same
 *     day, and a second NCNS row would contradict HR's own call. The same check
 *     folds duplicate pending rows (#902/#903/#904 are one person, one day) into
 *     one row. The personal email only SKIPS an insert here; it never keys a
 *     write, which is the line the Offboarded tab draws (the deletion reaper's
 *     hold makes the same allowance).
 * Every read is paged past the 1,000-row cap, and any failed read stops the run
 * before a write. A full ledger backup and the inserted ids land in
 * `references/backups/` (gitignored), so the insert is reversible by id.
 */
import dotenv from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

dotenv.config({ path: '.env.local', quiet: true });
dotenv.config({ quiet: true });

const { createClient } = await import('@supabase/supabase-js');
const { buildNoShowLedgerRow, pendingIdFromLedgerNote } = await import('../src/lib/hr/no-show-ledger');
type NoShowLedgerRow = import('../src/lib/hr/no-show-ledger').NoShowLedgerRow;

const apply = process.argv.includes('--apply');
const BACKUP_DIR = 'references/backups';
const SAME_EVENT_DAYS = 3;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

type Row = Record<string, unknown>;
async function readAll(table: string, select: string, order: string, filter?: (q: any) => any): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(select).order(order, { ascending: true }).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} read failed at row ${from}: ${error.message}`);
    out.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}
const n = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const day = (v: unknown) => (typeof v === 'string' && v ? Date.parse(v) : NaN);

async function main() {
  const [pending, ledger, live] = await Promise.all([
    readAll(
      'hr_pending_employees',
      'id, name, work_email, personal_email, department, status, no_show_at, no_show_by, no_show_note, orientation_attended_at',
      'id',
      (q) => q.eq('status', 'no_show'),
    ),
    readAll('offboarded_sheet', '*', 'id'),
    readAll('global_master_list', 'id, "Work Email"', 'id', (q) => q.is('off_boarded_at', null)),
  ]);
  const liveWork = new Set(live.map((r) => n(r['Work Email'])).filter(Boolean));
  const markers = new Set(ledger.map((r) => pendingIdFromLedgerNote(r.off_boarded_note as string | null)).filter((x): x is number => x !== null));

  console.log(`no_show rows ${pending.length} · ledger rows ${ledger.length} · live master rows ${live.length}`);

  const inserts: NoShowLedgerRow[] = [];
  const report: { id: unknown; name: unknown; outcome: string }[] = [];
  for (const p of pending) {
    const id = Number(p.id);
    if (p.orientation_attended_at) { report.push({ id, name: p.name, outcome: 'skip: carries an attended stamp (an attendance, not a no-show)' }); continue; }
    if (!p.no_show_at) { report.push({ id, name: p.name, outcome: 'skip: no no_show_at date' }); continue; }
    if (markers.has(id)) { report.push({ id, name: p.name, outcome: 'skip: already on the list (marker)' }); continue; }

    const pe = n(p.personal_email);
    const at = day(p.no_show_at);
    const near = (r: { personal_email?: unknown; off_boarded_at?: unknown }) =>
      n(r.personal_email) === pe && Math.abs(day(r.off_boarded_at) - at) <= SAME_EVENT_DAYS * 86_400_000;
    const sameEvent = pe ? ledger.find(near) : undefined;
    if (sameEvent) {
      report.push({ id, name: p.name, outcome: `skip: already recorded as ledger #${sameEvent.id} (${sameEvent.off_boarded_reason}, ${String(sameEvent.off_boarded_at).slice(0, 10)})` });
      continue;
    }
    const samePlanned = pe ? inserts.find(near) : undefined;
    if (samePlanned) {
      report.push({ id, name: p.name, outcome: `skip: same person, same no-show as pending #${pendingIdFromLedgerNote(samePlanned.off_boarded_note)}` });
      continue;
    }

    const markedBy = typeof p.no_show_by === 'string' && p.no_show_by.trim() ? p.no_show_by : null;
    if (!markedBy) { report.push({ id, name: p.name, outcome: 'skip: no no_show_by — would have to invent the actor' }); continue; }

    const work = n(p.work_email);
    const d = buildNoShowLedgerRow({
      pendingId: id,
      name: (p.name as string | null) ?? null,
      workEmail: (p.work_email as string | null) ?? null,
      personalEmail: (p.personal_email as string | null) ?? null,
      department: (p.department as string | null) ?? null,
      noShowAt: p.no_show_at as string,
      markedBy,
      managerNote: (p.no_show_note as string | null) ?? null,
      workEmailLive: work ? liveWork.has(work) : false,
    });
    if (d.kind === 'skip') { report.push({ id, name: p.name, outcome: `skip: ${d.reason}` }); continue; }
    inserts.push(d.row);
    report.push({
      id,
      name: p.name,
      outcome: `INSERT ${String(p.no_show_at).slice(0, 10)} ${d.row.department ?? '—'}${d.workEmailWithheld ? ` · work email withheld (${d.workEmailWithheld})` : ''}`,
    });
  }

  for (const r of report) console.log(`  #${r.id}  ${r.name ?? '(no name)'}  →  ${r.outcome}`);
  const withheld = inserts.filter((r) => r.work_email === null).length;
  console.log(`\nTo insert: ${inserts.length}  (work email withheld or absent on ${withheld})`);

  if (!inserts.length) { console.log('Nothing to insert.'); return; }
  if (!apply) { console.log('\nDry run — re-run with --apply to write.'); return; }

  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `offboarded_sheet_pre_noshow_backfill_${stamp}.json`);
  writeFileSync(backupPath, JSON.stringify({ ledger, planned: inserts }, null, 2), 'utf8');
  console.log(`\nBackup written: ${backupPath}  (${ledger.length} ledger rows + ${inserts.length} planned)`);

  const { data, error } = await sb.from('offboarded_sheet').insert(inserts).select('id, off_boarded_note');
  if (error) {
    console.error(`INSERT failed: ${error.message} — nothing was written (one statement).`);
    process.exit(1);
  }
  const insertedIds = (data ?? []).map((r) => r.id);
  const idsPath = path.join(BACKUP_DIR, `offboarded_sheet_noshow_backfill_inserted_ids_${stamp}.json`);
  writeFileSync(idsPath, JSON.stringify(insertedIds), 'utf8');
  console.log(`Inserted ${insertedIds.length} rows; ids → ${idsPath}`);

  // Read back rather than trust the write.
  const after = await readAll('offboarded_sheet', 'id, off_boarded_note', 'id');
  const counts = new Map<number, number>();
  for (const r of after) {
    const pid = pendingIdFromLedgerNote(r.off_boarded_note as string | null);
    if (pid !== null) counts.set(pid, (counts.get(pid) ?? 0) + 1);
  }
  const dupes = [...counts].filter(([, c]) => c > 1);
  const planned = inserts.map((r) => pendingIdFromLedgerNote(r.off_boarded_note)!);
  const missing = planned.filter((pid) => !counts.has(pid));
  console.log(`Ledger now ${after.length} rows (expected ${ledger.length + inserts.length}) · markers missing ${missing.length} · duplicated ${dupes.length}`);
  if (after.length !== ledger.length + inserts.length || missing.length || dupes.length) {
    console.error('Read-back does not match — investigate before trusting the list.');
    process.exit(1);
  }
  console.log('Done.');
}

main().catch((e) => {
  console.error('\nFAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
