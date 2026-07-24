// Discovery probe: find EVERY row in EVERY plausible table that references a
// given email, across each table's known email-ish columns.
//
// Read-only. Prints a report of table -> column -> matching rows. Nothing is
// deleted here; use the report to author a targeted delete.
//
// Usage:  node scripts/find-email-everywhere.mjs randalh@hogansmith.com
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const TARGET = (process.argv[2] || "").trim().toLowerCase();
if (!TARGET) {
  console.log("Usage: node scripts/find-email-everywhere.mjs <email>");
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.log("Missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// table -> candidate email columns to probe. Quoted-with-spaces names are used
// verbatim (global_master_list / employee_hourly_rates); everything else is
// snake_case. A column that doesn't exist just yields a PG 42703 we skip.
const PROBES = {
  global_master_list: ["Work Email", "Personal Email"],
  employee_hourly_rates: ["Work Email", "Personal Email"],
  employee_ids: [
    "work_email",
    "personal_email",
    "hurupay_email",
    "wepay_email",
    "higlobe_email",
    "wise_email",
    "alternate_work_email",
    "alternate_work_email_2",
  ],
  active_employees: ["work_email", "personal_email", "email"],
  offboarded_sheet: ["work_email", "personal_email"],
  employee_roles: ["work_email", "email", "user_email"],
  employee_feature_permissions: ["work_email", "email", "user_email"],
  department_managers: ["work_email", "email", "manager_email"],
  employee_rate_history: ["work_email", "email"],
  hr_onboarding_submissions: ["work_email", "personal_email", "email"],
  hr_pending_employees: ["work_email", "personal_email", "email"],
  employee_notifications: ["recipient_email", "recipient", "work_email", "email"],
  hsl_bonus_entries: ["work_email", "member_email", "email"],
  active_hsl_agents: ["work_email", "email"],
  disbursement_records: ["work_email", "email", "recipient_email"],
  payment_dispatches: ["work_email", "email", "recipient_email"],
  bank_preferred_change_requests: ["work_email", "email"],
  employee_calltools_usernames: ["work_email", "email"],
  employee_skill_sets: ["work_email", "email"],
  bank_update_history: ["work_email", "email"],
};

const results = [];

for (const [table, cols] of Object.entries(PROBES)) {
  for (const col of cols) {
    // Quote column names that contain spaces so PostgREST treats them literally.
    const ref = col.includes(" ") ? `"${col}"` : col;
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .ilike(ref, TARGET);

    if (error) {
      const msg = error.message || "";
      // 42P01 = table missing, 42703 = column missing -> expected, skip quietly.
      if (/does not exist|schema cache|column .* does not exist/i.test(msg)) continue;
      console.log(`  [skip] ${table}.${col}: ${msg}`);
      continue;
    }
    if (data && data.length) {
      results.push({ table, col, rows: data });
    }
  }
}

if (!results.length) {
  console.log(`No rows found referencing "${TARGET}" in any probed table/column.`);
  process.exit(0);
}

console.log(`\n=== Matches for "${TARGET}" ===\n`);
for (const r of results) {
  console.log(`TABLE ${r.table}  (matched on ${r.col})  -> ${r.rows.length} row(s)`);
  for (const row of r.rows) {
    // Print id + a compact identity slice, plus dump full row for the record.
    const idish = row.id ?? row.employee_id ?? row.uuid ?? "(no id col)";
    console.log(`  id=${idish}`);
    console.log("  " + JSON.stringify(row));
  }
  console.log("");
}
