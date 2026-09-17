/**
 * READ-ONLY probe: run the REAL COE recent-bonus read for one person and print
 * every week's itemisation beside what payment_dispatches says was paid.
 *
 * Kane, 2026-09-17: the COE "is not inputting all the bonus info, so the
 * amounts on the COE are less than what they asked to be on them" — gyd@ is
 * missing a 25,000 bonus that payment_dispatches records inside
 * system_bonus_php = 30,000 for the week 2026-08-23 -> 08-29.
 *
 * Calls resolveCoeFacts + listEmployeePayStubs exactly as the certificate
 * does. Only SELECTs are issued.
 *
 * Usage: node --import tsx scripts/probe-coe-recent-bonuses.mts [email...]
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const { resolveCoeFacts } = await import("../src/lib/documents/coe-facts");
const { listEmployeePayStubs } = await import("../src/lib/payroll/employee-paystubs");
const { createSupabaseServiceRoleClient } = await import("../src/lib/supabase/server");

const supabase = createSupabaseServiceRoleClient();
if (!supabase) {
  console.error("No service-role client — check .env.local");
  process.exit(1);
}

const TARGETS = (process.argv.slice(2).length ? process.argv.slice(2) : ["gyd@simple.biz"]).map((e) =>
  e.toLowerCase().trim(),
);
const money = (n: unknown) =>
  typeof n === "number" ? n.toLocaleString("en-US", { minimumFractionDigits: 2 }).padStart(12) : String(n).padStart(12);

for (const email of TARGETS) {
  console.log("\n" + "=".repeat(100) + `\n${email}\n` + "=".repeat(100));

  const { data: disp } = await supabase
    .from("payment_dispatches")
    .select("cycle_period_start, cycle_period_end, cycle_source_file, amount_php, system_bonus_php, system_bonus_label, status")
    .ilike("recipient_email", email);
  const paidByFile = new Map(
    (disp ?? []).map((d: any) => [String(d.cycle_source_file), d]),
  );

  const t0 = Date.now();
  const { stubs } = await listEmployeePayStubs(email, {});
  console.log(`listEmployeePayStubs: ${stubs.length} weeks in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  console.log(
    "week".padEnd(25) +
      "PAB".padStart(12) + "Tech".padStart(12) + "Perf".padStart(12) + "Adj".padStart(12) +
      "stub total".padStart(14) + "  |" + "paid hourly".padStart(14) + "sys_bonus".padStart(12) + "  label",
  );
  for (const s of stubs.slice(0, 12)) {
    const v = s.view;
    const d: any = paidByFile.get(s.sourceFile);
    console.log(
      `${(v.weekStart ?? "?") + "→" + (v.weekEnd ?? "?")}`.padEnd(25) +
        money(v.attendanceBonus) + money(v.techBonus) + money(v.performanceBonus) + money(v.adjustment) +
        money(v.totalPayPhp).padStart(14) + "  |" +
        money(d?.amount_php ?? null).padStart(14) + money(d?.system_bonus_php ?? null) + "  " + (d?.system_bonus_label ?? ""),
    );
  }

  const facts = await resolveCoeFacts(email);
  console.log("\n-- resolveCoeFacts --");
  if (facts.error) console.log("  ERROR:", facts.error);
  if (facts.blocked) console.log("  BLOCKED:", facts.blocked.code, facts.blocked.message);
  if (facts.facts) {
    console.log("  recentBonuses:", JSON.stringify(facts.facts.recentBonuses, null, 2));
    console.log("  performanceBonuses (standing):", JSON.stringify(facts.facts.performanceBonuses));
    console.log("  standardBonuses (standing):", JSON.stringify(facts.facts.standardBonuses));
  }
}

console.log("\nDone — read-only, nothing written.");
