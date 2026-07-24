// Hard-remove the stray "Randal Hayes" (randalh@hogansmith.com) record.
//
// Discovery (find-email-everywhere.mjs + find-name-everywhere.mjs) proved this
// email/name exists in exactly ONE row: a single PENDING cycle row in
// disbursement_records, id a6ebd67e-44cf-4987-932d-44d90655eefb, sourced from the
// 2026-06-28..07-04 Hubstaff daily report. No employee/master/rate/role record,
// no bank data, no dispatch_id — a stray Hubstaff import artifact.
//
// Safety: SELECT-to-backup first (gitignored JSON), delete by explicit id, verify.
// Dry-run by default. Pass --apply to actually delete.
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { writeFileSync, mkdirSync } from "node:fs";

dotenv.config();

const APPLY = process.argv.includes("--apply");
const ROW_ID = "a6ebd67e-44cf-4987-932d-44d90655eefb";
const EMAIL = "randalh@hogansmith.com";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.log("Missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// 1) SELECT full row for backup + confirm it's still the one we expect.
const { data: rows, error: selErr } = await supabase
  .from("disbursement_records")
  .select("*")
  .eq("id", ROW_ID);

if (selErr) { console.log("Select error:", selErr.message); process.exit(1); }
if (!rows || rows.length === 0) {
  console.log(`Row ${ROW_ID} not found — already gone? Nothing to do.`);
  process.exit(0);
}
const row = rows[0];
if ((row.recipient_email || "").toLowerCase() !== EMAIL) {
  console.log(`SAFETY ABORT: row ${ROW_ID} recipient_email is "${row.recipient_email}", not "${EMAIL}".`);
  process.exit(1);
}
console.log("Target row:");
console.log("  " + JSON.stringify(row));

// 2) Backup BEFORE deleting.
mkdirSync("references/backups", { recursive: true });
const backupPath = "references/backups/2026-07-24_randal-hayes_disbursement_deleted.json";
writeFileSync(backupPath, JSON.stringify(row, null, 2), "utf8");
console.log(`\nBackup written: ${backupPath}`);

if (!APPLY) {
  console.log("\nDRY RUN — nothing deleted. Re-run with --apply to delete.");
  process.exit(0);
}

// 3) Delete by explicit id.
const { error: delErr } = await supabase
  .from("disbursement_records")
  .delete()
  .eq("id", ROW_ID);
if (delErr) { console.log("\nDELETE error:", delErr.message); process.exit(1); }

// 4) Verify gone.
const { data: check, error: verErr } = await supabase
  .from("disbursement_records")
  .select("id")
  .ilike("recipient_email", EMAIL);
if (verErr) { console.log("Deleted, but verify failed:", verErr.message); process.exit(1); }

if (check && check.length) {
  console.log(`WARNING: ${check.length} row(s) still match ${EMAIL}. Investigate.`);
  process.exit(1);
}
console.log(`\nDeleted. No remaining rows reference ${EMAIL} in disbursement_records.`);
