/**
 * READ-ONLY verifier for the departed-member guard. SELECT only; it never deals
 * and never writes.
 *
 * Runs the REAL `loadQcDepartedEmails` — the function the QC deal, the QC
 * assignments route and the KPI calculator all use — against production for a
 * given pay week, and reports who it hides and who it keeps.
 *
 * Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"
 *   node --import tsx scripts/verify-qc-departed-members.mts [--week=YYYY-MM-DD] [email ...]
 *
 * Optional emails ASSERT that each one is hidden for that week; exits 1 if any
 * is still visible.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const { loadQcDepartedEmails } = await import('../src/lib/qc/departed-members');
const { getEmployeesForAuthorizedServerRoute } = await import('../src/lib/supabase/employees');
const { normalizeDeptToKey } = await import('../src/lib/payroll/normalize-dept-key');
const { isQcDeptKey } = await import('../src/lib/qc/constants');
const { isQcPeriodStart } = await import('../src/lib/qc/period');
const { normEmail } = await import('../src/lib/email/norm-email');

const args = process.argv.slice(2);
const week = args.find((a) => a.startsWith('--week='))?.slice('--week='.length) ?? '2026-09-06';
if (!isQcPeriodStart(week)) {
  console.error(`--week must be a pay-week Sunday; ${week} is not`);
  process.exit(1);
}
const asserts = args.filter((a) => !a.startsWith('--')).map((e) => e.trim().toLowerCase());

const { employees } = await getEmployeesForAuthorizedServerRoute();
const { emails, error } = await loadQcDepartedEmails(employees, week);
console.log(`week ${week} · roster ${employees.length}`);
if (error) console.log(`DEGRADED: ${error}  (an empty set hides nobody)`);

let qcHidden = 0;
let qcKept = 0;
const sample: string[] = [];
for (const e of employees) {
  if (!isQcDeptKey(normalizeDeptToKey(e.department))) continue;
  const w = normEmail(e.work_email ?? null);
  const p = normEmail(e.personal_email ?? null);
  const hidden = (w && emails.has(w)) || (p && emails.has(p));
  if (hidden) {
    qcHidden++;
    if (sample.length < 15) sample.push(`${e.name}  <${w || p}>`);
  } else qcKept++;
}
console.log(`\nhidden emails in the set : ${emails.size}`);
console.log(`QC-scored departments     : ${qcHidden} hidden / ${qcKept} kept`);
console.log(`\nsample hidden:`);
for (const s of sample) console.log(`   - ${s}`);

// What the assert means: this person must not be REACHABLE on the calculator.
// Two states satisfy that, and the first is strictly stronger:
//   GONE   — not on the active roster at all, because their master row is
//            stamped and `active_employees` never serves them. This is where
//            the 2026-09-14 backfill put the 178 July leavers.
//   HIDDEN — still on the roster, filtered out by the departed guard.
// The first cut asserted HIDDEN only, and began failing the moment the backfill
// made people GONE — reporting the fix as a regression.
const onRoster = new Set<string>();
for (const e of employees) {
  for (const addr of [e.work_email, e.personal_email]) {
    const n = normEmail(addr ?? null);
    if (n) onRoster.add(n);
  }
}
let failed = 0;
for (const a of asserts) {
  const gone = !onRoster.has(a);
  const hidden = emails.has(a);
  const state = gone
    ? 'GONE from the roster (correct, and stronger than hidden)'
    : hidden
      ? 'HIDDEN by the guard (correct)'
      : 'REACHABLE';
  console.log(`\nASSERT ${a}: ${state}`);
  if (!gone && !hidden) failed++;
}
if (failed > 0) {
  console.error(`\nFAIL: ${failed} asserted email(s) are still visible for ${week}.`);
  process.exit(1);
}
console.log('\nOK');
