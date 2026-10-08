/**
 * Re-date the HR queue's 2026-10-07 offboard of Mark Arriola's GHOST master row
 * to his real departure (audit item 384; Kane's ruling (b), 2026-10-07).
 *
 * `global_master_list` 327a7857 is the name-in-email ghost of 5dba371f
 * (`marka@simple.biz`, off-boarded 2026-07-16 ncns). People gave it `marka@` on
 * 2026-10-06 16:27Z, so at 2026-10-07 13:28:39Z jakec@ could complete jackie@'s
 * queue row badf971b and `/api/hr/offboard` stamped it `ncns`, dated TODAY. That is
 * the stamp `stamp-arriola-ghost-row.mts` exists to avoid, and that script will not
 * touch a row someone else stamped. `revert-arriola-ghost-fields.mts` has already
 * put the three addresses back.
 *
 * ## What it writes
 *
 * ONE row, the four `off_boarded_*` columns, to exactly what the stamp script
 * would have written (gml-roster-source-of-truth.md § Name-in-email ghost rows):
 *   - `off_boarded_at = 2026-07-16`, NOT 10-07: `listOffboardedSince`
 *     (`src/lib/supabase/qc-db.ts`) re-deals any row stamped on/after a week's
 *     start, so the 10-07 stamp would deal the ghost a Lead Gen slot for 10-04.
 *   - `off_boarded_reason = duplicate_cleanup`, outside `DEPARTURE_REASONS`.
 *
 * It replaces ONLY jakec@'s exact stamp. Its actor is its own, so the stamp
 * script's `--revert` (which un-stamps to null) can never act on this row.
 *
 * It does NOT touch: `offboarded_sheet` 46418 (the queue's second departure
 * row, Kane's call), the queue rows, `scheduled_deletion_at` /
 * `deletion_processed_at`, the 09-20 ₱750 (Kane's money ruling), or any webhook.
 *
 * ## What stops it
 *
 * Every check must pass, and any read that fails REFUSES `--apply`:
 *   0. the stamp is exactly the queue's (13:28:39.316Z, ncns, jakec@, no note),
 *   1. the row looks like the ghost again (name, no Work Email, a name in
 *      Personal Email), so the field revert has run,
 *   2. it is not on the current master upload,
 *   3. the real row is stamped 2026-07-16, and `offboarded_sheet` holds it,
 *   4. no other unstamped master row is his,
 *   5. no disbursement for any of his keys after the 07-12 cycle,
 *   6. no hours in the current Hubstaff cycle under his emails or name.
 * The UPDATE repeats check 0 as filters. Filters are `.eq`, never `.in()`, for
 * the name key.
 *
 * READ-ONLY WITHOUT A FLAG. `--apply` writes, and `--revert` puts jakec@'s stamp
 * back exactly. Both write a SELECT backup to `docs/audits/backups/` (gitignored)
 * first.
 *
 * Usage (PowerShell; `cycle-hours-index.ts` imports `server-only`):
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"
 *   node --import tsx scripts/redate-arriola-ghost-stamp.mts            # plan only
 *   node --import tsx scripts/redate-arriola-ghost-stamp.mts --apply    # re-date
 *   node --import tsx scripts/redate-arriola-ghost-stamp.mts --revert   # undo
 */
import dotenv from 'dotenv';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');
const REVERT = process.argv.includes('--revert');
if (APPLY && REVERT) {
  console.error('Pass --apply or --revert, not both.');
  process.exit(1);
}

const GHOST_ID = '327a7857-eddd-491f-886c-f0058c6cb45b';
const REAL_ID = '5dba371f-1e72-45e5-a1a9-f678601ea01c';
const REAL_WORK = 'marka@simple.biz';
const REAL_PERSONAL = 'markarriola.sos@gmail.com';
const DEPARTED_DAY = '2026-07-16';
/** His last paid cycle started 07-12; anything later means someone is live on these keys. */
const LAST_CYCLE_START = '2026-07-12';
const ACTOR = 'system:arriola-ghost-redate-2026-10-07';
/** The only stamp this script replaces, measured 2026-10-07 (audit `hr.employee.offboarded`). */
const QUEUE_STAMP = {
  off_boarded_at: '2026-10-07T13:28:39.316+00:00',
  off_boarded_reason: 'ncns',
  off_boarded_by: 'jakec@simple.biz',
  off_boarded_note: null,
} as const;
const STAMP = {
  off_boarded_at: `${DEPARTED_DAY}T00:00:00+00:00`,
  off_boarded_reason: 'duplicate_cleanup',
  off_boarded_by: ACTOR,
  off_boarded_note:
    `name-in-email ghost of ${REAL_ID} (${REAL_WORK}, off-boarded ${DEPARTED_DAY} ncns); ` +
    `re-dated from the HR queue offboard ${QUEUE_STAMP.off_boarded_at} ncns by ${QUEUE_STAMP.off_boarded_by} ` +
    '(queue badf971b), audit item 384',
};
const STAMP_COLS = ['off_boarded_at', 'off_boarded_reason', 'off_boarded_by', 'off_boarded_note'] as const;

const { createSupabaseServiceRoleClient } = await import('../src/lib/supabase/server');
const { loadCycleHoursIndex, personWorkedCycle } = await import('../src/lib/payroll/cycle-hours-index');

const sb = createSupabaseServiceRoleClient();
if (!sb) {
  console.error('Supabase is not configured (.env.local)');
  process.exit(1);
}

const mode = APPLY ? 'APPLY' : REVERT ? 'REVERT' : 'PLAN (read-only)';
console.log(`${mode} · ghost ${GHOST_ID.slice(0, 8)} → real ${REAL_ID.slice(0, 8)} <${REAL_WORK}>\n`);

const failures: string[] = [];
const check = (ok: boolean, label: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const day = (v: unknown) => str(v).slice(0, 10);
const stampOf = (row: Record<string, unknown>) =>
  STAMP_COLS.map((c) => `${c}=${row[c] == null ? 'null' : JSON.stringify(row[c])}`).join(' · ');
/** Timestamps compare as instants: PostgREST may echo `+00:00` where the constant says `Z`, or the reverse. */
const sameInstant = (a: unknown, b: string) => typeof a === 'string' && Date.parse(a) === Date.parse(b);

const ghostRead = await sb.from('global_master_list').select('*').eq('id', GHOST_ID).maybeSingle();
const realRead = await sb.from('global_master_list').select('*').eq('id', REAL_ID).maybeSingle();
if (ghostRead.error || realRead.error || !ghostRead.data || !realRead.data) {
  console.error(`Master read failed: ${ghostRead.error?.message ?? realRead.error?.message ?? 'row missing'}`);
  process.exit(1);
}
const ghost = ghostRead.data as Record<string, unknown>;
const real = realRead.data as Record<string, unknown>;

// The SELECT backup, before anything else can write. CLAUDE.md § Data.
const dir = join(process.cwd(), 'docs', 'audits', 'backups');
mkdirSync(dir, { recursive: true });
const backupPath = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-arriola-ghost-redate.json`);
writeFileSync(backupPath, JSON.stringify({ mode, takenAt: new Date().toISOString(), ghost, real }, null, 2), 'utf8');
console.log(`Backup written: ${backupPath}\n`);
console.log(`stamp now: ${stampOf(ghost)}\n`);

// ── --revert: put jakec@'s stamp back exactly ────────────────────────────────
if (REVERT) {
  if (str(ghost.off_boarded_by) !== ACTOR) {
    console.log(`Nothing to revert: the ghost's stamp is not this script's (off_boarded_by = ${str(ghost.off_boarded_by) || 'null'}).`);
    process.exit(0);
  }
  const { data, error } = await sb
    .from('global_master_list')
    .update({ ...QUEUE_STAMP })
    .eq('id', GHOST_ID)
    .eq('off_boarded_by', ACTOR)
    .select('*');
  if (error || (data ?? []).length !== 1) {
    console.error(`Revert failed: ${error?.message ?? `${(data ?? []).length} rows matched, expected 1`}`);
    process.exit(1);
  }
  console.log(`Reverted: ${stampOf((data as Record<string, unknown>[])[0])}`);
  process.exit(0);
}

// ── Already done? ────────────────────────────────────────────────────────────
if (str(ghost.off_boarded_by) === ACTOR) {
  console.log(`Already re-dated by this script (${day(ghost.off_boarded_at)}). Nothing to do.`);
  process.exit(0);
}

// ── Guards ───────────────────────────────────────────────────────────────────
console.log('guards:');

// 0. The stamp is exactly the queue's.
check(
  sameInstant(ghost.off_boarded_at, QUEUE_STAMP.off_boarded_at) &&
    ghost.off_boarded_reason === QUEUE_STAMP.off_boarded_reason &&
    ghost.off_boarded_by === QUEUE_STAMP.off_boarded_by &&
    ghost.off_boarded_note === QUEUE_STAMP.off_boarded_note,
  `stamp is exactly the 10-07 queue offboard (${QUEUE_STAMP.off_boarded_at} ncns by ${QUEUE_STAMP.off_boarded_by}, no note)`,
);

// 1. Still the ghost, with the field revert done.
check(/arriola/i.test(str(ghost['Name'])), `ghost Name is Arriola's ("${str(ghost['Name'])}")`);
check(!str(ghost['Work Email']), 'ghost has no Work Email (the field revert has run)');
check(!str(ghost['Alternate Work Email']), 'ghost has no Alternate Work Email');
check(
  !!str(ghost['Personal Email']) && !str(ghost['Personal Email']).includes('@'),
  `ghost Personal Email is a name, not an address ("${str(ghost['Personal Email'])}")`,
);

// 2. Not on the current master upload.
const ups = await sb.from('master_list_uploads').select('id').eq('is_current', true);
if (ups.error || (ups.data ?? []).length !== 1) {
  check(false, `exactly one current master upload (${ups.error?.message ?? `${(ups.data ?? []).length} flagged`})`);
} else {
  const cur = (ups.data as { id: string }[])[0].id;
  check(ghost.last_seen_upload_id !== cur, `ghost is NOT on the current master upload (${cur.slice(0, 8)})`);
}

// 3. The real person's departure is on record.
check(str(real['Work Email']).toLowerCase() === REAL_WORK, `real row's Work Email is ${REAL_WORK}`);
check(day(real.off_boarded_at) === DEPARTED_DAY, `real row is stamped ${DEPARTED_DAY} (${day(real.off_boarded_at) || 'unstamped'})`);
const sheet = await sb
  .from('offboarded_sheet')
  .select('work_email, personal_email, off_boarded_at, off_boarded_reason')
  .ilike('personal_email', REAL_PERSONAL);
if (sheet.error) check(false, `offboarded_sheet readable (${sheet.error.message})`);
else
  check(
    (sheet.data ?? []).some((r) => day(r.off_boarded_at) === DEPARTED_DAY),
    `offboarded_sheet holds the ${DEPARTED_DAY} departure`,
  );

// 4. No other unstamped master row is his (a re-hire would be one).
const others = await sb
  .from('global_master_list')
  .select('id, "Name", "Work Email", "Personal Email"')
  .is('off_boarded_at', null)
  .neq('id', GHOST_ID)
  .or(`"Work Email".ilike.${REAL_WORK},"Personal Email".ilike.${REAL_PERSONAL},"Name".ilike.%arriola%`);
if (others.error) check(false, `active master rows readable (${others.error.message})`);
else check((others.data ?? []).length === 0, `no other active master row for him (${(others.data ?? []).length} found)`);

// 5. Nothing paid on his keys after his last cycle. The ghost key is read with
// `.eq`, never inside `.in()`: its quotes and comma silently match nothing there.
const ghostKey = str(ghost['Personal Email']).toLowerCase();
const paidReads = await Promise.all([
  sb
    .from('disbursement_records')
    .select('recipient_email')
    .in('recipient_email', [REAL_WORK, REAL_PERSONAL])
    .gt('cycle_period_start', LAST_CYCLE_START),
  sb
    .from('disbursement_records')
    .select('recipient_email')
    .eq('recipient_email', ghostKey)
    .gt('cycle_period_start', LAST_CYCLE_START),
]);
const paidErr = paidReads.find((r) => r.error)?.error;
const paidCount = paidReads.reduce((n, r) => n + (r.data ?? []).length, 0);
if (paidErr) check(false, `disbursement_records readable (${paidErr.message})`);
else check(paidCount === 0, `no disbursement after the ${LAST_CYCLE_START} cycle (${paidCount} found)`);

// 6. No hours in the current cycle.
const hours = await loadCycleHoursIndex(null);
if (hours.error) check(false, `current Hubstaff cycle readable (${hours.error})`);
else
  check(
    !personWorkedCycle(hours, { emails: [REAL_WORK, REAL_PERSONAL], name: str(real['Name']) || str(ghost['Name']) }),
    'no hours in the current Hubstaff cycle',
  );

console.log(`\nWOULD RE-DATE ${GHOST_ID}:`);
for (const c of STAMP_COLS) console.log(`  ${c.padEnd(18)} ${JSON.stringify(ghost[c] ?? null)}  →  ${JSON.stringify(STAMP[c])}`);

if (failures.length > 0) {
  console.error(`\nREFUSING: ${failures.length} guard(s) failed. Nothing written.`);
  process.exit(1);
}
if (!APPLY) {
  console.log('\nPLAN ONLY — nothing written. Re-run with --apply to re-date it.');
  process.exit(0);
}

// ── Apply ────────────────────────────────────────────────────────────────────
const { data, error } = await sb
  .from('global_master_list')
  .update(STAMP)
  .eq('id', GHOST_ID)
  // Only the exact stamp guard 0 read. Anything that changed since matches 0 rows.
  .eq('off_boarded_at', str(ghost.off_boarded_at))
  .eq('off_boarded_reason', QUEUE_STAMP.off_boarded_reason)
  .eq('off_boarded_by', QUEUE_STAMP.off_boarded_by)
  .is('off_boarded_note', null)
  .is('"Work Email"', null)
  // scheduled_deletion_at / deletion_processed_at are deliberately UNTOUCHED.
  .select('*');
if (error || (data ?? []).length !== 1) {
  console.error(`\nRe-date failed: ${error?.message ?? `${(data ?? []).length} rows matched, expected 1`}`);
  process.exit(1);
}

const after = (data as Record<string, unknown>[])[0];
const moved = Object.keys({ ...ghost, ...after }).filter((k) => JSON.stringify(ghost[k]) !== JSON.stringify(after[k]));
const exact = moved.length === STAMP_COLS.length && STAMP_COLS.every((c) => moved.includes(c));
console.log(`\nRe-dated. Columns changed: ${moved.join(', ')}${exact ? '' : '  ← NOT the four expected, check the backup'}`);
console.log(`  ${stampOf(after)}`);
const active = await sb.from('active_employees').select('id').eq('id', GHOST_ID);
console.log(`On active_employees: ${active.error ? `unreadable (${active.error.message})` : (active.data ?? []).length === 0 ? 'no' : 'STILL YES — check the view'}`);
console.log('Undo: node --import tsx scripts/redate-arriola-ghost-stamp.mts --revert');
if (!exact) process.exit(1);
