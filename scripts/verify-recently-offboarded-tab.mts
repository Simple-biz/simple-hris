/**
 * READ-ONLY verifier: runs the REAL `listOffboardedPayrollCandidates()` — the
 * function behind the Payroll Notes FAB's "Offboarded" tab
 * (GET /api/payroll-wizard/offboarded) — from the command line.
 *
 * Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"; node --import tsx scripts/verify-recently-offboarded-tab.mts [--source-file=<name>]
 *
 * Prints every person the tab would show, their rate/bank status, and flags
 * (as an error exit) any `temporary_pause` leakage — that reason must never
 * reach this list (see offboarded-final-pay-eligibility.ts).
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const { listOffboardedPayrollCandidates } = await import(
  "../src/lib/payroll/offboarded-payroll-candidates"
);
const { listRecentlyOffboardedPeople } = await import("../src/lib/roster/recently-offboarded");

const args = process.argv.slice(2);
const sourceFile = args.find((a) => a.startsWith("--source-file="))?.slice("--source-file=".length) ?? null;

const { people, weekLabel, degraded, error } = await listOffboardedPayrollCandidates(sourceFile);
if (error) {
  console.error(`ERROR: ${error}`);
  process.exit(1);
}

console.log(`pay week in view: ${weekLabel}`);
if (degraded.length > 0) {
  console.log("degraded reads:");
  for (const d of degraded) console.log(`  - ${d}`);
}

console.log(`\noffboarded tab would show: ${people.length} people`);
for (const p of people) {
  console.log(
    `  ${p.offBoardedAt ?? "(no date)"} · ${p.name} [${p.department ?? "—"}] ` +
      `reason=${p.offBoardedReasonLabel ?? "—"} rate=${p.rateStatus} bank=${p.bankStatus}` +
      (p.bankProcessor ? ` (${p.bankProcessor})` : ""),
  );
}

// Sanity check: temporary_pause must never leak through, even indirectly via
// a source that doesn't carry the reason cleanly.
const { people: allOffboarded } = await listRecentlyOffboardedPeople(90);
const pausedEmails = new Set(
  allOffboarded
    .filter((p) => p.off_boarded_reason === "temporary_pause")
    .flatMap((p) => [p.work_email, p.personal_email])
    .filter((e): e is string => !!e)
    .map((e) => e.toLowerCase()),
);
const leaked = people.filter(
  (p) =>
    (p.workEmail && pausedEmails.has(p.workEmail.toLowerCase())) ||
    (p.personalEmail && pausedEmails.has(p.personalEmail.toLowerCase())),
);
if (leaked.length > 0) {
  console.error(`\nFAIL: ${leaked.length} temporary_pause person(s) leaked into the tab:`);
  for (const p of leaked) console.error(`  ${p.name}`);
  process.exit(1);
}
console.log("\nOK: no temporary_pause leakage.");
