// Hard-remove "Randal Hayes" (randalh@hogansmith.com) rows from hubstaff_hours.
//
// Follow-up to scripts/delete-randal-hayes.mjs (2026-07-24), which deleted his
// stray disbursement_records row but left the RAW hours rows behind — so the
// disbursement seeder could recreate the row from them, and each new weekly
// Hubstaff report kept re-importing him (3 uploads as of 2026-07-25).
//
// The permanent fix is the ingest blocklist in
// src/lib/supabase/hubstaff-hours-db.ts (HUBSTAFF_INGEST_BLOCKED_EMAILS);
// this script cleans up the rows that got in before the blocklist existed.
//
// Safety: SELECT-to-backup first (gitignored JSON), delete by explicit ids,
// verify. Dry-run by default. Pass --apply to actually delete.
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { writeFileSync, mkdirSync } from "node:fs";

dotenv.config();

const APPLY = process.argv.includes("--apply");
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

// 1) SELECT full rows for backup.
const { data: rows, error: selErr } = await supabase
  .from("hubstaff_hours")
  .select("*")
  .ilike("Email", EMAIL);

if (selErr) { console.log("Select error:", selErr.message); process.exit(1); }
if (!rows || rows.length === 0) {
  console.log(`No hubstaff_hours rows match ${EMAIL} — already clean. Nothing to do.`);
  process.exit(0);
}

console.log(`Found ${rows.length} row(s):`);
for (const r of rows) {
  console.log(`  id=${r.id}  source_file=${r.source_file}`);
}

// 2) Backup BEFORE deleting.
mkdirSync("references/backups", { recursive: true });
const backupPath = "references/backups/2026-07-25_randal-hayes_hubstaff_hours_deleted.json";
writeFileSync(backupPath, JSON.stringify(rows, null, 2), "utf8");
console.log(`\nBackup written: ${backupPath}`);

if (!APPLY) {
  console.log("\nDRY RUN — nothing deleted. Re-run with --apply to delete.");
  process.exit(0);
}

// 3) Delete by explicit ids (never a broad filter).
const ids = rows.map((r) => r.id);
const { error: delErr } = await supabase
  .from("hubstaff_hours")
  .delete()
  .in("id", ids);
if (delErr) { console.log("\nDELETE error:", delErr.message); process.exit(1); }

// 4) Verify gone.
const { data: check, error: verErr } = await supabase
  .from("hubstaff_hours")
  .select("id")
  .ilike("Email", EMAIL);
if (verErr) { console.log("Deleted, but verify failed:", verErr.message); process.exit(1); }

if (check && check.length) {
  console.log(`WARNING: ${check.length} row(s) still match ${EMAIL}. Investigate.`);
  process.exit(1);
}
console.log(`\nDeleted ${ids.length} row(s). No remaining rows reference ${EMAIL} in hubstaff_hours.`);
