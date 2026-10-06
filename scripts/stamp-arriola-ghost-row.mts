/**
 * Stamp Mark Arriola's GHOST master row off-boarded (audit item 364).
 *
 * `global_master_list` 327a7857 is a `Global-Master-List-MASTERLIST.csv` import
 * row (batch 1) with his NAME in Personal Email and no Work Email. The real
 * person is 5dba371f (`marka@simple.biz`), off-boarded 2026-07-16 `ncns`. The
 * 07-16 stamp matched `marka@` and nothing points at a row with no address, so
 * the ghost stayed on `active_employees`. It kept being dealt a Lead Gen KPI card,
 * and on 2026-10-06 Carla queued it for offboarding, which the HR queue
 * correctly refuses (no work email).
 *
 * The 2026-09-21 reconcile (`reconcile-gml-active-only.mts`) could not classify it
 * either: a name is not an email, so it matched no person and no departure
 * record, and it went to "needs HR review" with no write.
 *
 * ## What it writes
 *
 * ONE row, the four `off_boarded_*` columns:
 *   - `off_boarded_at = 2026-07-16`, the real person's departure. NOT today:
 *     the QC deal re-adds every row stamped on/after a week's start
 *     (`listOffboardedSince`, `src/lib/supabase/qc-db.ts`), so a today stamp
 *     would still deal the ghost a Lead Gen slot for the current week.
 *   - `off_boarded_reason = duplicate_cleanup`, outside `DEPARTURE_REASONS`.
 *     His departure is already on the real row, and this must not record a
 *     second one.
 *
 * It does NOT touch: the offboarding queue row (HR clicks Dismiss), the 09-20
 * ₱750 bonus keyed on the ghost (Kane's money ruling), `offboarded_sheet`, the
 * Google master sheet (the ghost left it after 2026-06-11), or any webhook.
 * Slots already dealt are sticky, so the 09-20 / 09-27 cards stay as they are.
 *
 * ## What stops it stamping a live person
 *
 * Every check must pass, and any read that fails REFUSES `--apply`:
 *   1. the row still looks like the ghost (name, no Work Email, no `@` in
 *      Personal Email, unstamped),
 *   2. it is not on the current master upload,
 *   3. the real row is stamped 2026-07-16, and `offboarded_sheet` holds the
 *      departure,
 *   4. no other unstamped master row is his (a re-hire would be one),
 *   5. no disbursement for any of his keys after the 07-12 cycle,
 *   6. no hours in the current Hubstaff cycle under his emails or name.
 *
 * READ-ONLY WITHOUT A FLAG. `--apply` writes, and `--revert` clears exactly what
 * this script stamped. Both write a SELECT backup to `docs/audits/backups/`
 * (gitignored) first.
 *
 * Usage (PowerShell):
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"
 *   node --import tsx scripts/stamp-arriola-ghost-row.mts            # plan only
 *   node --import tsx scripts/stamp-arriola-ghost-row.mts --apply    # stamp
 *   node --import tsx scripts/stamp-arriola-ghost-row.mts --revert   # undo
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
const ACTOR = 'system:arriola-ghost-cleanup-2026-10-06';
const NOTE =
  `name-in-email ghost of ${REAL_ID} (${REAL_WORK}, off-boarded ${DEPARTED_DAY} ncns); ` +
  'MASTERLIST.csv import row, audit item 364';

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
const backupPath = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-arriola-ghost-stamp.json`);
writeFileSync(backupPath, JSON.stringify({ mode, takenAt: new Date().toISOString(), ghost, real }, null, 2), 'utf8');
console.log(`Backup written: ${backupPath}\n`);

// ── --revert: clear only what this script stamped ────────────────────────────
if (REVERT) {
  if (str(ghost.off_boarded_by) !== ACTOR) {
    console.log(`Nothing to revert: the ghost's stamp is not this script's (off_boarded_by = ${str(ghost.off_boarded_by) || 'null'}).`);
    process.exit(0);
  }
  const { data, error } = await sb
    .from('global_master_list')
    .update({ off_boarded_at: null, off_boarded_reason: null, off_boarded_by: null, off_boarded_note: null })
    .eq('id', GHOST_ID)
    .eq('off_boarded_by', ACTOR)
    .select('id');
  if (error || (data ?? []).length !== 1) {
    console.error(`Revert failed: ${error?.message ?? `${(data ?? []).length} rows matched, expected 1`}`);
    process.exit(1);
  }
  console.log('Reverted: the ghost row is unstamped and back on active_employees.');
  process.exit(0);
}

// ── Already done? ────────────────────────────────────────────────────────────
if (ghost.off_boarded_at) {
  const mine = str(ghost.off_boarded_by) === ACTOR;
  console.log(
    mine
      ? `Already stamped by this script (${day(ghost.off_boarded_at)}). Nothing to do.`
      : `Already stamped by someone else: ${day(ghost.off_boarded_at)} ${str(ghost.off_boarded_reason)} by ${str(ghost.off_boarded_by)}. Not touching it.`,
  );
  process.exit(0);
}

// ── Guards ───────────────────────────────────────────────────────────────────
console.log('guards:');

// 1. Still the ghost.
check(/arriola/i.test(str(ghost['Name'])), `ghost Name is Arriola's ("${str(ghost['Name'])}")`);
check(!str(ghost['Work Email']), 'ghost has no Work Email');
check(!!str(ghost['Personal Email']) && !str(ghost['Personal Email']).includes('@'), `ghost Personal Email is a name, not an address ("${str(ghost['Personal Email'])}")`);

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
// `.eq`, never inside `.in()`: its quotes and comma silently match nothing there
// (measured 2026-10-06 against bonus_catalog_applied: `.in` 0 rows, `.eq` 2).
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

console.log(`\nWOULD STAMP ${GHOST_ID}:`);
console.log(`  off_boarded_at     = ${DEPARTED_DAY}`);
console.log('  off_boarded_reason = duplicate_cleanup');
console.log(`  off_boarded_by     = ${ACTOR}`);
console.log(`  off_boarded_note   = ${NOTE}`);

if (failures.length > 0) {
  console.error(`\nREFUSING: ${failures.length} guard(s) failed. Nothing written.`);
  process.exit(1);
}
if (!APPLY) {
  console.log('\nPLAN ONLY — nothing written. Re-run with --apply to stamp it.');
  process.exit(0);
}

// ── Apply ────────────────────────────────────────────────────────────────────
const { data, error } = await sb
  .from('global_master_list')
  .update({
    off_boarded_at: `${DEPARTED_DAY}T00:00:00+00:00`,
    off_boarded_reason: 'duplicate_cleanup',
    off_boarded_by: ACTOR,
    off_boarded_note: NOTE,
  })
  .eq('id', GHOST_ID)
  .is('off_boarded_at', null) // never re-stamp a row someone else just stamped
  // scheduled_deletion_at / deletion_processed_at are deliberately UNTOUCHED.
  .select('id');
if (error || (data ?? []).length !== 1) {
  console.error(`\nStamp failed: ${error?.message ?? `${(data ?? []).length} rows matched, expected 1`}`);
  process.exit(1);
}

const after = await sb.from('active_employees').select('id').eq('id', GHOST_ID);
console.log(`\nStamped. On active_employees now: ${after.error ? `unreadable (${after.error.message})` : (after.data ?? []).length === 0 ? 'no' : 'STILL YES — check the view'}`);
console.log(`Undo: node --import tsx scripts/stamp-arriola-ghost-row.mts --revert`);
