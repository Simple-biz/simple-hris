/**
 * Fix Chris Lawang's split-identity rate shadow (Kane, 2026-08-18).
 *
 * One human, two master rows: `chrisl@simple.biz` (proper row,
 * hsl:intake_specialist, offboarded 2026-08-14 ncns) and `lawangc@simple.biz`
 * (duplicate row, bare "HSL" — and the email his Hubstaff hours ride).
 * 2026-08-04 a Readiness "Set rate" filed an EMPLOYEE-scope Payment Catalog
 * structure `pay_mse34sctiw8xsiio` = ₱175 / lead_gen under lawangc@. Individual
 * catalog is the TOP of the rate chain, so every 225 saved under chrisl@
 * (3× on 2026-08-18) could never win for the identity that logs his hours.
 *
 * This script aligns the lawangc@ identity to the correct ₱225 HSL rate:
 *   1. payment_catalog_pay_structures pay_mse34sctiw8xsiio → 225 / 337.5 /
 *      hogan_smith_law (UPDATE by primary key, not delete — the override stays,
 *      it just stops disagreeing with the chrisl@ one).
 *   2. employee_hourly_rates 03b7882a-… ("Work Email" lawangc@) → 225 / 337.5.
 *   3. employee_rate_history: INSERT a 225 row for lawangc@ effective
 *      2026-08-16, mirroring the chrisl@ save carla@ made — history outranks
 *      the sheet mirror in pay math, so it must not keep saying 175.
 *
 * NOT touched: the Google rates sheet / HSL Pay Plan sheet cells (Kane said
 * he'll set the rate by hand there), and the master-row duplication itself
 * (the real disease — merging rows is its own, bigger surgery).
 *
 * Usage:
 *   node --import tsx scripts/fix-lawang-rate-shadow.mts           # dry run
 *   node --import tsx scripts/fix-lawang-rate-shadow.mts --apply   # write
 *
 * A SELECT backup of every row about to change is written to
 * references/backups/ BEFORE any write (also on dry runs, harmless).
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

dotenv.config({ path: ".env.local" });
dotenv.config();

const APPLY = process.argv.includes("--apply");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const STRUCTURE_ID = "pay_mse34sctiw8xsiio";
const SHEET_ROW_ID = "03b7882a-98fd-4c48-ab34-bab59cf2c568";
const EMAIL = "lawangc@simple.biz";
const REG = 225;
const OT = 337.5;
const EFFECTIVE = "2026-08-16"; // mirrors the chrisl@ 225 row carla@ saved
const TAG = "fix-lawang-rate-shadow.mts";

// ── Backup (always, before anything) ─────────────────────────────────────────
const [structRes, sheetRes, histRes] = await Promise.all([
  sb.from("payment_catalog_pay_structures").select("*").eq("id", STRUCTURE_ID),
  sb.from("employee_hourly_rates").select("*").eq("id", SHEET_ROW_ID),
  sb.from("employee_rate_history").select("*").eq("employee_email", EMAIL),
]);
for (const [label, res] of [
  ["structure", structRes],
  ["sheet-mirror", sheetRes],
  ["rate-history", histRes],
] as const) {
  if (res.error) {
    console.error(`Backup read failed (${label}): ${res.error.message}`);
    process.exit(1);
  }
}
const backup = {
  taken_at: new Date().toISOString(),
  payment_catalog_pay_structures: structRes.data,
  employee_hourly_rates: sheetRes.data,
  employee_rate_history: histRes.data,
};
const backupPath = "references/backups/2026-08-18_lawang_rate_shadow_backup.json";
writeFileSync(backupPath, JSON.stringify(backup, null, 2));
console.log(`Backup written: ${backupPath}`);

const structure = (structRes.data ?? [])[0] as Record<string, unknown> | undefined;
const sheetRow = (sheetRes.data ?? [])[0] as Record<string, unknown> | undefined;
if (!structure) {
  console.error(`Structure ${STRUCTURE_ID} not found — nothing to fix (already deleted?).`);
  process.exit(1);
}

console.log("\nCurrent state:");
console.log(`  structure ${STRUCTURE_ID}: ${structure.regular_rate}/${structure.ot_rate} ${structure.department_key} (${structure.employee_email})`);
console.log(`  sheet row ${SHEET_ROW_ID}: ${sheetRow ? `${sheetRow["Regular Rate"]}/${sheetRow["OT Rate"]}` : "MISSING"}`);
console.log(`  rate-history rows for ${EMAIL}: ${(histRes.data ?? []).length}`);

if (!APPLY) {
  console.log("\nDRY RUN — would apply:");
  console.log(`  1. structure ${STRUCTURE_ID} → regular ${REG}, ot ${OT}, department_key hogan_smith_law`);
  console.log(`  2. sheet row ${SHEET_ROW_ID} → "Regular Rate" ${REG}, "OT Rate" ${OT}`);
  console.log(`  3. rate-history INSERT ${EMAIL} ${REG}/${OT} effective ${EFFECTIVE}`);
  console.log("\nRe-run with --apply to write.");
  process.exit(0);
}

// ── Apply ────────────────────────────────────────────────────────────────────
{
  const { error } = await sb
    .from("payment_catalog_pay_structures")
    .update({
      regular_rate: REG,
      ot_rate: OT,
      department_key: "hogan_smith_law",
      employee_name: 'Lawang, Christopher "Chris"',
      updated_by: TAG,
      updated_at: new Date().toISOString(),
    })
    .eq("id", STRUCTURE_ID);
  if (error) {
    console.error(`structure update FAILED: ${error.message}`);
    process.exit(1);
  }
  console.log(`structure ${STRUCTURE_ID} → ${REG}/${OT} hogan_smith_law ✓`);
}

if (sheetRow) {
  const { error } = await sb
    .from("employee_hourly_rates")
    .update({ "Regular Rate": REG, "OT Rate": OT })
    .eq("id", SHEET_ROW_ID);
  if (error) {
    console.error(`sheet-mirror update FAILED: ${error.message}`);
    process.exit(1);
  }
  console.log(`sheet-mirror ${SHEET_ROW_ID} → ${REG}/${OT} ✓`);
}

{
  const { error } = await sb.from("employee_rate_history").insert({
    employee_email: EMAIL,
    regular_rate: String(REG),
    ot_rate: String(OT),
    effective_from: EFFECTIVE,
    note: `duplicate-identity fix: mirrors chrisl@simple.biz 225 save (carla@ 2026-08-18); via ${TAG}`,
    created_by: TAG,
  });
  if (error) {
    console.error(`rate-history insert FAILED: ${error.message}`);
    process.exit(1);
  }
  console.log(`rate-history ${EMAIL} ${REG}/${OT} effective ${EFFECTIVE} ✓`);
}

console.log("\nDone. Verify with: node --import tsx scripts/tmp-probe-lawang-rate.mts");
