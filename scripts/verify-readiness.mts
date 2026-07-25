/**
 * READ-ONLY verifier: runs the REAL `getPayrollReadiness()` — the exact
 * production function behind GET /api/payroll-wizard/readiness — from the
 * command line, so the Readiness dashboard's numbers can be checked against
 * production logic (not a hand-maintained replica that drifts).
 *
 * Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"; node --import tsx scripts/verify-readiness.ts [source_file]
 *
 * (The custom tsconfig maps the `server-only` marker import — which Next shims
 * at build time but plain Node cannot resolve — to an empty local stub.)
 *
 * Optional [source_file] pins a specific Hubstaff upload (a replayed week);
 * omitted = the live `is_current` upload, same as the dashboard default.
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const sourceFile = process.argv[2] ?? null;

// Import AFTER dotenv so the Supabase clients see the env when constructed.
const { getPayrollReadiness } = await import("../src/lib/payroll/payroll-readiness");

const r = await getPayrollReadiness(sourceFile);

console.log(`week: ${r.weekStart} (${r.weekLabel})  monthly=${r.isMonthlyPayWeek}`);
console.log(`source file: ${r.sourceFile ?? "(none)"}`);

const kpiDue = r.kpi.filter((d) => d.status !== "na" && d.status !== "excluded");
const kpiSubmitted = kpiDue.filter(
  (d) => d.status === "ready" || d.status === "locked" || d.status === "no_bonus",
);
console.log(`\nKPI: ${kpiSubmitted.length}/${kpiDue.length} submitted (${r.kpi.length} listed)`);
for (const d of r.kpi.filter((x) => x.status !== "ready" && x.status !== "locked" && x.status !== "no_bonus")) {
  console.log(`  - ${d.name} [${d.key}] -> ${d.status}`);
}
const custom = r.kpi.filter((x) => x.source === "custom");
console.log(`custom/derived rows (${custom.length}):`);
for (const d of custom) {
  console.log(`  - ${d.name} [${d.key}] -> ${d.status}`);
}

console.log(`\ndegraded: ${r.degraded.length === 0 ? "(none — clean load)" : ""}`);
for (const d of r.degraded) console.log(`  ! ${d}`);

console.log(`\nNo pay rate: ${r.missingRates.length} of ${r.workerCount} workers`);
console.log(
  `Missing bank: ${r.missingBank.length} of ${r.bankEligibleCount} eligible · ON THIS WEEK'S PAYROLL: ${r.missingBankOnPayroll}`,
);
console.log(`Exceptions: ${r.exceptions.length}`);

console.log(`\nScore: ${r.score.value}/100 · grade=${r.score.grade}`);
for (const c of r.score.components) {
  console.log(
    `  ${c.label.padEnd(15)} ${String(c.points).padStart(2)}/${c.maxPoints} · ${c.percent}% · open=${c.open} blockers=${c.blockerOpen}`,
  );
}

const blockers = r.missingBank.filter((m) => m.onPayroll);
console.log(`\nFirst 10 on-payroll bank blockers (of ${blockers.length}):`);
for (const m of blockers.slice(0, 10)) {
  console.log(`  - ${m.name} [${m.department}] ${m.processor ? `${m.processor} · incomplete` : "no processor"}`);
}
