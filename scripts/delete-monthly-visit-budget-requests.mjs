// Hard-deletes ALL orphanage_budget_requests with visit_type='monthly'.
// Deletes the REQUEST ROWS ONLY — linked orphanage_dispatches (paid) records
// are left intact, as confirmed 2026-07-23.
//
// Safety: SELECT-to-backup first (full rows -> gitignored JSON in
// references/backups/), then delete by explicit id list, then verify count == 0.
//
// Dry-run by default. Pass --apply to actually delete.
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { writeFileSync, mkdirSync } from "node:fs";

dotenv.config();

const APPLY = process.argv.includes("--apply");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.log("Missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// 1) SELECT full rows for backup.
const { data: rows, error: selErr } = await supabase
  .from("orphanage_budget_requests")
  .select("*")
  .eq("visit_type", "monthly")
  .order("submitted_at", { ascending: false });

if (selErr) {
  console.log("Select error:", selErr.message);
  process.exit(1);
}
if (!rows || rows.length === 0) {
  console.log("No monthly visit budget requests found — nothing to do.");
  process.exit(0);
}

const ids = rows.map((r) => r.id);
console.log(`Found ${rows.length} monthly-visit request(s):`);
for (const r of rows) {
  console.log(`  ${r.id}  ${r.status}  PHP ${r.final_amount}  ${r.submitted_at}`);
}

// 2) Write backup BEFORE any delete.
mkdirSync("references/backups", { recursive: true });
const backupPath =
  "references/backups/2026-07-23_monthly_visit_budget_requests_deleted.json";
writeFileSync(backupPath, JSON.stringify(rows, null, 2), "utf8");
console.log(`\nBackup written: ${backupPath}`);

if (!APPLY) {
  console.log("\nDRY RUN — no rows deleted. Re-run with --apply to delete.");
  process.exit(0);
}

// 3) Delete by explicit id list (request rows only; dispatches untouched).
const { error: delErr } = await supabase
  .from("orphanage_budget_requests")
  .delete()
  .in("id", ids);

if (delErr) {
  console.log("\nDELETE error:", delErr.message);
  process.exit(1);
}

// 4) Verify.
const { count, error: verErr } = await supabase
  .from("orphanage_budget_requests")
  .select("id", { count: "exact", head: true })
  .eq("visit_type", "monthly");

if (verErr) {
  console.log("Deleted, but verify query failed:", verErr.message);
  process.exit(1);
}

console.log(`\nDeleted ${ids.length} row(s). Remaining monthly-visit requests: ${count}`);
if (count !== 0) {
  console.log("WARNING: expected 0 remaining. Investigate.");
  process.exit(1);
}
console.log("Done. Paid dispatch records were left intact.");
