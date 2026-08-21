/**
 * READ-ONLY verifier: runs the REAL `loadCatalogOffboardedEmails()` — the exact
 * production function behind `prefetchAccountingData().catalogOffboardedEmails`,
 * which is what the Payment Catalog filters its people surfaces on — against the
 * live roster, and prints who it hides and, more importantly, WHY it keeps
 * everyone else.
 *
 * Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"; node --import tsx scripts/verify-catalog-offboarded.mts [email ...]
 *
 * Optional emails: assert each one is KEPT (visible). Exits 1 if any is hidden —
 * that is the direction that costs money, so it is the direction worth pinning.
 * Use `--hidden email...` to assert the opposite.
 *
 * Writes nothing. Every query is a SELECT.
 */
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { getEmployees } = await import('../src/lib/supabase/employees');
const { loadCatalogOffboardedEmails } = await import(
  '../src/lib/payment-catalog/catalog-offboarded-emails'
);
const { loadOffboardEvidenceByEmail } = await import('../src/lib/roster/offboard-evidence');
const { loadCycleHoursIndex, personWorkedCycle } = await import(
  '../src/lib/payroll/cycle-hours-index'
);
const { normalizeMasterDate } = await import('../src/lib/roster/master-date');
const { payrollNotesWeekStart } = await import('../src/lib/payroll/manila-week');
const { normEmail } = await import('../src/lib/email/norm-email');

const args = process.argv.slice(2);
const hiddenIdx = args.indexOf('--hidden');
const expectKept = (hiddenIdx === -1 ? args : args.slice(0, hiddenIdx))
  .filter((a) => !a.startsWith('--'))
  .map((a) => a.trim().toLowerCase());
const expectHidden = (hiddenIdx === -1 ? [] : args.slice(hiddenIdx + 1))
  .filter((a) => !a.startsWith('--'))
  .map((a) => a.trim().toLowerCase());

const { employees, error } = await getEmployees();
if (error) {
  console.error(`roster read failed: ${error}`);
  process.exit(1);
}

const result = await loadCatalogOffboardedEmails(employees);
const hidden = new Set(result.emails);

console.log(`pay week in view          : ${payrollNotesWeekStart()}`);
console.log(`active roster             : ${employees.length}`);
console.log(`hidden from the catalog   : ${hidden.size} emails`);
console.log(`catalog shows             : ${employees.length - countHiddenPeople()} people`);
if (result.error) console.log(`DEGRADED                 : ${result.error}`);

function countHiddenPeople(): number {
  let n = 0;
  for (const e of employees) {
    const keys = [normEmail(e.work_email), normEmail(e.personal_email)].filter(Boolean) as string[];
    if (keys.some((k) => hidden.has(k))) n += 1;
  }
  return n;
}

// ── Why each person carrying evidence landed where it did ───────────────────

const evidence = await loadOffboardEvidenceByEmail('work');
const hours = await loadCycleHoursIndex(null);
const cycleWeekStart = payrollNotesWeekStart();

const buckets = {
  hidden: [] as string[],
  keptNotADeparture: [] as string[],
  keptStartDateGuard: [] as string[],
  keptFinalPayGrace: [] as string[],
  keptCycleHours: [] as string[],
};

const DEPARTURE = new Set(
  ['ncns', 'resigned', 'end_of_contract', 'performance', 'attendance', 'time_manipulation', 'other'],
);
const reasonKey = (raw: string | null) =>
  (raw ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || null;

for (const e of employees) {
  const keys = [normEmail(e.work_email), normEmail(e.personal_email)].filter(Boolean) as string[];
  if (keys.length === 0) continue;
  // Work addresses only, matching the real function.
  const workKeys = [
    normEmail(e.work_email),
    normEmail(e.alternate_work_email),
    normEmail(e.alternate_work_email_2),
  ].filter(Boolean) as string[];
  let rec: { offDate: string; reason: string | null } | null = null;
  for (const k of workKeys) {
    const r = evidence.get(k);
    if (r && (!rec || r.offDate > rec.offDate)) rec = r;
  }
  if (!rec) continue;

  const started = normalizeMasterDate(e.start_date);
  const line = `${rec.offDate}  ${(keys[0] ?? '').padEnd(26)} ${(e.name ?? '').slice(0, 34).padEnd(34)} ${(e.department ?? '').padEnd(30)} [start ${started ?? 'unparseable'}${rec.reason ? `, ${rec.reason}` : ''}]`;

  const rk = reasonKey(rec.reason);
  if (!rk || !DEPARTURE.has(rk)) buckets.keptNotADeparture.push(line);
  else if (!started || rec.offDate <= started) buckets.keptStartDateGuard.push(line);
  else if (rec.offDate >= cycleWeekStart) buckets.keptFinalPayGrace.push(line);
  else if (personWorkedCycle(hours, { emails: keys, name: e.name })) buckets.keptCycleHours.push(line);
  else buckets.hidden.push(line);
}

const section = (title: string, rows: string[]) => {
  console.log(`\n${title} (${rows.length})`);
  for (const r of rows.sort().reverse()) console.log(`  ${r}`);
};

console.log(`\ncarrying off-board evidence: ${Object.values(buckets).reduce((n, b) => n + b.length, 0)}`);
section('KEPT — not a departure (temporary_pause / duplicate_cleanup / unrecognised / blank)', buckets.keptNotADeparture);
section('KEPT — start-date guard (re-hire / stale record)', buckets.keptStartDateGuard);
section(`KEPT — final-pay grace (left on/after ${cycleWeekStart})`, buckets.keptFinalPayGrace);
section(`KEPT — hours in ${hours.sourceFile ?? 'the current timesheet'} (STILL WORKING)`, buckets.keptCycleHours);
section('HIDDEN', buckets.hidden);

// ── Assertions ─────────────────────────────────────────────────────────────

let failed = false;
for (const em of expectKept) {
  if (hidden.has(em)) {
    console.error(`\nFAIL: ${em} is HIDDEN but was asserted visible`);
    failed = true;
  } else {
    console.log(`\nOK: ${em} is visible`);
  }
}
for (const em of expectHidden) {
  if (!hidden.has(em)) {
    console.error(`\nFAIL: ${em} is VISIBLE but was asserted hidden`);
    failed = true;
  } else {
    console.log(`\nOK: ${em} is hidden`);
  }
}

// The bucket the change exists to protect: nobody with hours in the live
// timesheet may ever be hidden. Checked against the real function's output, not
// the reconstruction above.
for (const e of employees) {
  const keys = [normEmail(e.work_email), normEmail(e.personal_email)].filter(Boolean) as string[];
  if (keys.length === 0) continue;
  if (!personWorkedCycle(hours, { emails: keys, name: e.name })) continue;
  if (keys.some((k) => hidden.has(k))) {
    console.error(`FAIL: ${keys[0]} has hours in the current timesheet but is hidden`);
    failed = true;
  }
}
if (!failed) console.log('\nOK: nobody with hours in the current timesheet is hidden.');

process.exit(failed ? 1 : 0);
