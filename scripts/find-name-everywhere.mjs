// Companion probe: find rows referencing a person's NAME (not just email),
// plus a scan of hubstaff_hours for the raw import source. Read-only.
// Usage: node scripts/find-name-everywhere.mjs "Randal Hayes" [emailToo]
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const NAME = (process.argv[2] || "").trim();
const EMAIL = (process.argv[3] || "").trim().toLowerCase();
if (!NAME) { console.log('Usage: node scripts/find-name-everywhere.mjs "Full Name" [email]'); process.exit(1); }

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

// table -> name columns to probe
const NAME_PROBES = {
  global_master_list: ["Name"],
  employee_hourly_rates: ["Name"],
  employee_ids: ["name", "account_holder_name"],
  active_employees: ["name", "full_name"],
  offboarded_sheet: ["name", "full_name"],
  hr_onboarding_submissions: ["full_name", "name"],
  hr_pending_employees: ["full_name", "name"],
  disbursement_records: ["recipient_name"],
  payment_dispatches: ["recipient_name", "name"],
  hsl_bonus_entries: ["name", "member_name"],
  active_hsl_agents: ["name"],
};

const pattern = `%${NAME}%`;
const hits = [];

for (const [table, cols] of Object.entries(NAME_PROBES)) {
  for (const col of cols) {
    const ref = col.includes(" ") ? `"${col}"` : col;
    const { data, error } = await supabase.from(table).select("*").ilike(ref, pattern);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message || "")) continue;
      console.log(`  [skip] ${table}.${col}: ${error.message}`); continue;
    }
    if (data?.length) hits.push({ table, col, rows: data });
  }
}

// Raw Hubstaff import scan (email + a couple likely name columns).
if (EMAIL) {
  for (const col of ["email", "member_email", "work_email"]) {
    const { data, error } = await supabase.from("hubstaff_hours").select("*").ilike(col, EMAIL);
    if (!error && data?.length) hits.push({ table: "hubstaff_hours", col, rows: data });
  }
}
for (const col of ["member", "name", "member_name"]) {
  const { data, error } = await supabase.from("hubstaff_hours").select("*").ilike(col, pattern);
  if (!error && data?.length) hits.push({ table: "hubstaff_hours", col, rows: data });
}

if (!hits.length) { console.log(`No rows referencing name "${NAME}"${EMAIL ? " / "+EMAIL : ""}.`); process.exit(0); }
console.log(`\n=== Name matches for "${NAME}" ===\n`);
for (const h of hits) {
  console.log(`TABLE ${h.table} (on ${h.col}) -> ${h.rows.length} row(s)`);
  for (const r of h.rows) console.log("  " + JSON.stringify(r));
  console.log("");
}
