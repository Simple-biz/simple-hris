/**
 * Stamp `off_boarded_*` onto active-roster rows belonging to people who have
 * demonstrably LEFT — the ghosts a `clearOffboarded` sync re-activated.
 *
 * READ-ONLY WITHOUT `--apply`. With `--apply` it writes a bulk UPDATE to
 * PRODUCTION, and refuses to start until it has written a full SELECT backup of
 * every row it intends to touch to disk.
 *
 * ## Why these people are on the roster at all
 *
 * `/api/hr/offboard` stamps correctly. The ingest path used to accept
 * `clearOffboarded`, which re-activated any stamped row whose stamp was older
 * than a 14-day grace — and the Admin checkbox that set it DEFAULTED TO TRUE.
 * 158 Lead Gen people, all stamped July 2026, came back with
 * `off_boarded_at = null` and were dealt QC scoring slots for weeks.
 *
 * Ingest can no longer do that (see `global-master-list-db.ts`). This script
 * repairs the rows it already broke. Run the code fix FIRST, or the next sync
 * undoes this.
 *
 * ## What stops it stamping a live person
 *
 * The same four guards the Payment Catalog and the QC deal use —
 * `hasDepartedBeforeWeek`, one shared implementation:
 *
 *   1. dated departure evidence, matched on **WORK email only** (a personal
 *      inbox is shared across duplicate identities and imports someone else's
 *      departure),
 *   2. a canonical **departure reason** — `duplicate_cleanup`, `sheet_sync` and
 *      `temporary_pause` never qualify,
 *   3. the record **post-dates their own Start Date** (re-hires),
 *   4. **no hours in the current cycle's timesheet** — a timesheet row cannot be
 *      forged by a stale stamp.
 *
 * Stamping a live person removes them from every surface in the HRIS and stops
 * their pay. Guard 4 is the one that catches what the dates miss; if the
 * timesheet cannot be read, this script REFUSES to apply rather than proceeding
 * on three guards.
 *
 * Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"
 *   node --import tsx scripts/backfill-offboard-stamps.mts            # plan only
 *   node --import tsx scripts/backfill-offboard-stamps.mts --apply    # writes
 */
import dotenv from 'dotenv';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');

const { createSupabaseServiceRoleClient } = await import('../src/lib/supabase/server');
const { getEmployeesForAuthorizedServerRoute } = await import('../src/lib/supabase/employees');
const { loadOffboardEvidenceByEmail } = await import('../src/lib/roster/offboard-evidence');
const { hasDepartedBeforeWeek } = await import('../src/lib/payment-catalog/catalog-roster-visibility');
const { loadCycleHoursIndex, personWorkedCycle } = await import('../src/lib/payroll/cycle-hours-index');
const { normalizeMasterDate } = await import('../src/lib/roster/master-date');
const { payrollNotesWeekStart } = await import('../src/lib/payroll/manila-week');
const { normEmail } = await import('../src/lib/email/norm-email');
const { normalizeDeptToKey } = await import('../src/lib/payroll/normalize-dept-key');

const sb = createSupabaseServiceRoleClient();
if (!sb) {
  console.error('Supabase is not configured (.env.local)');
  process.exit(1);
}

const week = payrollNotesWeekStart();
console.log(`${APPLY ? 'APPLY' : 'PLAN (read-only)'} · pay week in play: ${week}\n`);

// Guard 4's input. A read failure is fatal in apply mode: three guards are not
// four, and the missing one is the only one a wrong date cannot defeat.
const hours = await loadCycleHoursIndex(null);
if (hours.error) {
  console.error(`Cycle timesheet unreadable: ${hours.error}`);
  if (APPLY) {
    console.error('REFUSING to apply without the hours guard. Re-run when the timesheet reads.');
    process.exit(1);
  }
  console.error('(plan mode continues, but the plan below is NOT safe to apply)');
}

const [{ employees }, evidence] = await Promise.all([
  getEmployeesForAuthorizedServerRoute(),
  loadOffboardEvidenceByEmail('work'),
]);
console.log(`active roster: ${employees.length} · offboard evidence rows: ${evidence.size}`);

interface Target {
  work: string;
  name: string | null;
  department: string | null;
  offDate: string;
  reason: string | null;
}
const targets: Target[] = [];
for (const e of employees) {
  const work = normEmail(e.work_email ?? null);
  if (!work) continue;
  const ev = evidence.get(work);
  if (!ev) continue;
  const departed = hasDepartedBeforeWeek({
    evidence: ev,
    startDate: normalizeMasterDate(e.start_date ?? null),
    cycleWeekStart: week,
    hasCycleHours: hours.error
      ? true // unknown ⇒ treat as working ⇒ never stamp
      : personWorkedCycle(hours, { emails: [e.work_email, e.personal_email], name: e.name }),
  });
  if (!departed) continue;
  targets.push({
    work,
    name: e.name ?? null,
    department: e.department ?? null,
    offDate: ev.offDate,
    reason: ev.reason,
  });
}

const byDept = new Map<string, number>();
const byMonth = new Map<string, number>();
for (const t of targets) {
  const k = normalizeDeptToKey(t.department) ?? '(none)';
  byDept.set(k, (byDept.get(k) ?? 0) + 1);
  byMonth.set(t.offDate.slice(0, 7), (byMonth.get(t.offDate.slice(0, 7)) ?? 0) + 1);
}
console.log(`\nWOULD STAMP: ${targets.length} people\n`);
console.log('by department:');
for (const [k, n] of [...byDept].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(4)}  ${k}`);
console.log('\nby departure month:');
for (const [m, n] of [...byMonth].sort()) console.log(`   ${m}  ${n}`);
console.log('\nfirst 15:');
for (const t of targets.slice(0, 15)) console.log(`   ${t.offDate}  ${t.name}  <${t.work}>  ${t.reason ?? '—'}`);

if (targets.length === 0) {
  console.log('\nNothing to do.');
  process.exit(0);
}

// The SELECT backup — every master row this would touch, verbatim and complete,
// written BEFORE any write. CLAUDE.md: a bulk UPDATE needs one on disk first.
const dir = join(process.cwd(), 'docs', 'audits', 'backups');
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = join(dir, `${stamp}-offboard-stamp-backfill.json`);

const rows: unknown[] = [];
for (let i = 0; i < targets.length; i += 50) {
  const chunk = targets.slice(i, i + 50).map((t) => t.work);
  const { data, error } = await sb
    .from('global_master_list')
    .select('*')
    .in('"Work Email"', chunk);
  if (error) {
    console.error(`\nBackup read failed: ${error.message}`);
    process.exit(1);
  }
  rows.push(...(data ?? []));
}
writeFileSync(backupPath, JSON.stringify({ week, takenAt: new Date().toISOString(), targets, rows }, null, 2), 'utf8');
console.log(`\nBackup written: ${backupPath}  (${rows.length} master rows)`);

if (!APPLY) {
  console.log('\nPLAN ONLY — nothing written. Re-run with --apply to stamp these people.');
  process.exit(0);
}

console.log('\nApplying…');
let updated = 0;
let failed = 0;
for (const t of targets) {
  const { data, error } = await sb
    .from('global_master_list')
    .update({
      off_boarded_at: t.offDate,
      off_boarded_reason: t.reason ?? 'other',
      // Traceable: these were not stamped by a person, and the next reader
      // should be able to tell this apart from an HR offboard.
      off_boarded_by: 'backfill:offboard-evidence-2026-09-14',
    })
    .ilike('"Work Email"', t.work)
    .is('off_boarded_at', null)
    // scheduled_deletion_at / deletion_processed_at are deliberately UNTOUCHED.
    // This repairs a roster stamp; it does not schedule anyone for deletion.
    .select('id');
  if (error) {
    failed += 1;
    console.error(`   FAIL ${t.work}: ${error.message}`);
    continue;
  }
  updated += (data ?? []).length;
}
console.log(`\nrows stamped: ${updated} · failures: ${failed}`);
console.log(`backup: ${backupPath}`);
if (failed > 0) process.exit(1);
