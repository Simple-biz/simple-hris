/**
 * Correct juliar@simple.biz's hourly rate from PHP 279.99 to PHP 280
 * (Kane, 2026-09-15: "why is she always on 279.99 please make it 280";
 * "I think that was a rounding error").
 *
 * WHY SHE IS ON 279.99 - one individual catalog override, top of the rate chain:
 *   payment_catalog_pay_structures/pay_mqf8se92cwatkh1j - scope employee, dept
 *   accounting, 279.99 / 419.99 PHP, created by carla@ 2026-06-15, never updated.
 *   Its matching employee_rate_history row (a2052195-...) is 279.99 / 419.99
 *   effective 2026-06-22. 419.99 == 279.99 x 1.5 rounded, so ONE bad base value
 *   propagated into OT.
 *
 * The correct 280 was already present and outranked: employee_rate_history
 * 2e0d4e78-... holds 280 / 420 effective 2026-05-31 (sheet sync), and her NEWEST
 * employee_hourly_rates rows (2026-06-09/06-10) already read 280 / 420. Rates
 * resolve employee catalog -> sheet/history -> dept base, so the override won.
 * disbursement_records confirms she was PAID at 279.99 from 07-26 through 09-05.
 *
 * FORWARD-ONLY (memory/payroll-rule-changes-forward-only). EFFECTIVE is the start
 * of the live, unsent 09-06->09-12 week. Paid weeks are NOT re-priced: arrears at
 * PHP 0.01/hr over ~11 weeks is under PHP 10, and re-pricing a snapshotted week
 * would discard its Payroll Notes adjustments.
 *
 * TWO writes only:
 *   1. payment_catalog_pay_structures/pay_mqf8se92cwatkh1j -> 280 / 420 (UPDATE by
 *      primary key - the override stays, it just stops being wrong).
 *   2. employee_rate_history: INSERT 280 / 420 effective 2026-09-06. REQUIRED -
 *      the pay engine prices PER DAY from this table, so a structure-only update
 *      would change the display and not the money
 *      (memory/rate-catalog-source-of-truth, the 225-shown / 175-paid bug).
 *
 * NOT touched, deliberately:
 *   - employee_hourly_rates: her newest rows ALREADY read 280 / 420, and writing
 *     that table carries no updated_at stamp and silently re-prices history
 *     (memory/rate-updated-at-not-evidence).
 *   - The Google rates sheet cell (manual - RATES_SHEET_SYNC_DISABLED).
 *   - The 279.99 history row effective 2026-06-22: RETAINED. It is the dated
 *     record of what she was actually paid for those weeks. Deleting it would
 *     re-price eleven paid weeks, which is exactly what forward-only forbids.
 *
 * AFTER THIS RUNS: re-lock the 2026-09-06->09-12 week in the Payroll Wizard, or
 * disbursement_records keeps the old money. That re-lock also picks up her
 * approved 09-10 time adjustment (approved 2026-09-15 15:54Z - 24h AFTER the
 * staged row was computed at 2026-09-14 15:52Z, which is why the paystub misses
 * it while the live PAB calendar shows it).
 * WARNING: upsertPaystubDispatchQueue re-stages money onto PAID rows on a re-lock
 * (OPEN since 2026-08-26). Julia's row is `pending`, but the re-lock touches the
 * whole week.
 *
 * Usage:
 *   node --import tsx scripts/fix-juliar-rate-279-99.mts           # dry run
 *   node --import tsx scripts/fix-juliar-rate-279-99.mts --apply   # write
 *
 * A SELECT backup of every row that could change is written to
 * references/backups/ BEFORE any write (also on dry runs, harmless).
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

dotenv.config({ path: ".env.local" });
dotenv.config();

const APPLY = process.argv.includes("--apply");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const STRUCTURE_ID = "pay_mqf8se92cwatkh1j";
const EMAIL = "juliar@simple.biz";
const OLD_REG = 279.99;
const OLD_OT = 419.99;
const REG = 280;
const OT = 420;
const EFFECTIVE = "2026-09-06"; // start of the live, unsent pay week
const TAG = "fix-juliar-rate-279-99.mts";

// -- Backup (always, before anything) -----------------------------------------
const [structRes, histRes, ratesRes] = await Promise.all([
  sb.from("payment_catalog_pay_structures").select("*").eq("id", STRUCTURE_ID),
  sb.from("employee_rate_history").select("*").eq("employee_email", EMAIL),
  sb.from("employee_hourly_rates").select("*").eq("Work Email", EMAIL),
]);
for (const [label, res] of [
  ["structure", structRes],
  ["rate-history", histRes],
  ["hourly-rates", ratesRes],
] as const) {
  if (res.error) {
    console.error(`Backup read failed (${label}): ${res.error.message}`);
    process.exit(1);
  }
}
const backup = {
  taken_at: new Date().toISOString(),
  payment_catalog_pay_structures: structRes.data,
  employee_rate_history: histRes.data,
  employee_hourly_rates: ratesRes.data,
};
const backupPath = "references/backups/2026-09-15_juliar_rate_280_backup.json";
writeFileSync(backupPath, JSON.stringify(backup, null, 2));
console.log(`Backup written: ${backupPath}`);

const structure = (structRes.data ?? [])[0] as Record<string, unknown> | undefined;
if (!structure) {
  console.error(`Structure ${STRUCTURE_ID} not found - refusing to guess. Re-probe before running.`);
  process.exit(1);
}

// -- Guards: refuse on anything but the state this script was written for ------
if (structure.employee_email !== EMAIL) {
  console.error(`Structure ${STRUCTURE_ID} belongs to ${structure.employee_email}, not ${EMAIL}. Refusing.`);
  process.exit(1);
}
if (Number(structure.regular_rate) === REG && Number(structure.ot_rate) === OT) {
  console.log(`Structure already reads ${REG}/${OT} - nothing to do.`);
  process.exit(0);
}
if (Number(structure.regular_rate) !== OLD_REG || Number(structure.ot_rate) !== OLD_OT) {
  console.error(
    `Structure reads ${structure.regular_rate}/${structure.ot_rate}, expected ${OLD_REG}/${OLD_OT}. ` +
      `Someone changed it since this script was written - re-probe, do not run.`,
  );
  process.exit(1);
}
if (structure.currency !== "PHP") {
  console.error(`Structure currency is ${structure.currency}, not PHP. Refusing (cf. cop-rate-keyed-in-php-column).`);
  process.exit(1);
}

const history = (histRes.data ?? []) as Array<Record<string, unknown>>;
const already = history.find(
  (h) => h.effective_from === EFFECTIVE && Number(h.regular_rate) === REG && Number(h.ot_rate) === OT,
);

console.log("\nCurrent state:");
console.log(`  structure ${STRUCTURE_ID}: ${structure.regular_rate}/${structure.ot_rate} ${structure.department_key}`);
console.log(`  rate-history rows for ${EMAIL}: ${history.length}`);
for (const h of [...history].sort((a, b) => String(a.effective_from).localeCompare(String(b.effective_from)))) {
  console.log(`    eff ${h.effective_from}  ${h.regular_rate}/${h.ot_rate}  - ${h.note ?? ""} (${h.created_by})`);
}

console.log("\nPlanned writes:");
console.log(`  1. UPDATE structure ${STRUCTURE_ID} -> ${REG}/${OT}`);
console.log(
  already
    ? `  2. SKIP history insert - a ${REG}/${OT} row effective ${EFFECTIVE} already exists`
    : `  2. INSERT employee_rate_history ${EMAIL} ${REG}/${OT} effective ${EFFECTIVE}`,
);
console.log(`  (retaining the ${OLD_REG} row effective 2026-06-22 - it dates eleven PAID weeks)`);

if (!APPLY) {
  console.log("\nDRY RUN - nothing written. Re-run with --apply to write.");
  process.exit(0);
}

const upd = await sb
  .from("payment_catalog_pay_structures")
  .update({ regular_rate: REG, ot_rate: OT, updated_by: TAG, updated_at: new Date().toISOString() })
  .eq("id", STRUCTURE_ID)
  .eq("regular_rate", OLD_REG) // compare-and-swap: refuse if it moved under us
  .select();
if (upd.error) {
  console.error(`Structure update FAILED: ${upd.error.message}`);
  process.exit(1);
}
if ((upd.data ?? []).length !== 1) {
  console.error(`Structure update matched ${(upd.data ?? []).length} rows, expected 1. Value moved - stopping.`);
  process.exit(1);
}
console.log(`  OK structure ${STRUCTURE_ID} -> ${REG}/${OT}`);

if (!already) {
  const ins = await sb
    .from("employee_rate_history")
    .insert({
      employee_email: EMAIL,
      regular_rate: REG,
      ot_rate: OT,
      effective_from: EFFECTIVE,
      note: "corrected 279.99 rounding artefact to 280 (Kane 2026-09-15); forward-only from the live week",
      created_by: TAG,
    })
    .select();
  if (ins.error) {
    console.error(
      `History insert FAILED: ${ins.error.message} - structure is now ${REG} but history is NOT. Fix before paying.`,
    );
    process.exit(1);
  }
  console.log(`  OK rate-history ${REG}/${OT} effective ${EFFECTIVE}`);
}

console.log("\nDone. NEXT: re-lock the 2026-09-06->09-12 week in the Payroll Wizard,");
console.log("or disbursement_records keeps the 279.99 money and misses her approved 09-10 adjustment.");
