// Why doesn't <person> show the mid-week proration treatment for a given week?
// Read-only probe of every gate the wizard/dispatch engine checks:
//   1. is there `employee_rate_history` keyed on the person's HUBSTAFF email
//      (the only key the engine resolves — parity with Payment Dispatch)?
//   2. does a history row's effective_from land INSIDE the pay week (a row at or
//      before the week start = whole week at one rate, nothing to split)?
//   3. do they have an EMPLOYEE-scope Payment Catalog structure (engine skips
//      those — an individual rate is flat for the whole period)?
//   4. did the week's Hubstaff upload carry daily columns for them (no per-day
//      hours = proration unknowable)?
// Usage: node scripts/diagnose-proration.mjs "Full Name" [week-start-YYYY-MM-DD]
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.local" });

const NAME = (process.argv[2] || "").trim();
const WEEK = (process.argv[3] || "").trim();
if (!NAME) {
  console.log('Usage: node scripts/diagnose-proration.mjs "Full Name" [week-start-YYYY-MM-DD]');
  process.exit(1);
}
const namePat = `%${NAME.split(/\s+/).join("%")}%`;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) { console.error("missing supabase env"); process.exit(1); }
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

// 1) master list rows
const { data: master, error: mErr } = await sb
  .from("global_master_list")
  .select('"Name", "Department", "Work Email", "Personal Email", off_boarded_at')
  .ilike("Name", namePat);
console.log("── global_master_list:", mErr?.message ?? "");
for (const r of master ?? []) console.log(r);

const emails = new Set();
for (const r of master ?? []) {
  for (const e of [r["Work Email"], r["Personal Email"]]) {
    if (e && typeof e === "string" && e.trim()) emails.add(e.trim().toLowerCase());
  }
}

// 2) transfers
const orClauses = [`employee_name.ilike.${namePat}`];
if (emails.size) orClauses.push(`employee_email.in.(${[...emails].join(",")})`);
const { data: tr, error: tErr } = await sb
  .from("department_transfer_requests")
  .select("employee_name, employee_email, employee_work_email, from_department, to_department, status, proposed_effective_date, effective_date, applied_at")
  .or(orClauses.join(","))
  .order("created_at", { ascending: false })
  .limit(5);
console.log("\n── department_transfer_requests:", tErr?.message ?? "");
for (const r of tr ?? []) console.log(r);
if (!tr?.length) console.log("  (none)");
for (const r of tr ?? []) {
  const e = (r.employee_email || "").trim().toLowerCase();
  if (e) emails.add(e);
  const w = (r.employee_work_email || "").trim().toLowerCase();
  if (w) emails.add(w);
}

// 3) rate history for every alias
console.log("\n── employee_rate_history (per alias):");
for (const em of emails) {
  const { data: hist } = await sb
    .from("employee_rate_history")
    .select("employee_email, regular_rate, ot_rate, effective_from, created_by, note")
    .eq("employee_email", em)
    .order("effective_from", { ascending: false })
    .limit(6);
  if (hist?.length) for (const h of hist) console.log(h);
  else console.log(`  (none for ${em})`);
}

// 4) individual Payment Catalog structure (the engine SKIPS these)
const structOr = [`employee_name.ilike.${namePat}`];
if (emails.size) structOr.push(`employee_email.in.(${[...emails].join(",")})`);
const { data: structs, error: sErr } = await sb
  .from("payment_catalog_pay_structures")
  .select("scope, employee_email, employee_name, regular_rate, ot_rate, currency, created_at")
  .eq("scope", "employee")
  .or(structOr.join(","));
console.log("\n── payment_catalog_pay_structures (employee-scope):", sErr?.message ?? "");
for (const r of structs ?? []) console.log(r);
if (!structs?.length) console.log("  (none — engine will NOT skip on the individual-catalog gate)");

// 5) rates cache row (matched by email — the table has no Name column)
console.log("\n── employee_hourly_rates:");
if (emails.size) {
  const emailList = [...emails].join(",");
  const { data: rates } = await sb
    .from("employee_hourly_rates")
    .select('"Work Email", "Personal Email", "Regular Rate", "OT Rate", "Department"')
    .or(`"Work Email".in.(${emailList}),"Personal Email".in.(${emailList})`);
  for (const r of rates ?? []) console.log(r);
  if (!rates?.length) console.log("  (no cache row for any alias)");
}

function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

// 6) their Hubstaff row for the selected week — email key + daily columns
if (WEEK) {
  const { data: hub, error: hErr } = await sb
    .from("hubstaff_hours")
    .select('source_file, "Member", "Email", monday, tuesday, wednesday, thursday, friday, saturday, sunday, "Total worked"')
    .ilike("source_file", `%${WEEK}%`)
    .ilike("Member", namePat);
  console.log(`\n── hubstaff_hours (${WEEK} file):`, hErr?.message ?? "");
  for (const r of hub ?? []) console.log(r);
  if (!hub?.length) console.log(`  (no rows for Member ilike ${namePat} — check the name spelling in Hubstaff)`);

  // The engine's verdict, per Hubstaff email:
  for (const r of hub ?? []) {
    const hubEmail = (r["Email"] || "").trim().toLowerCase();
    const { data: hist } = await sb
      .from("employee_rate_history")
      .select("regular_rate, ot_rate, effective_from")
      .eq("employee_email", hubEmail)
      .order("effective_from", { ascending: false });
    const weekEnd = addDays(WEEK, 6);
    const inWeek = (hist ?? []).filter((h) => {
      const d = String(h.effective_from).slice(0, 10);
      return d > WEEK && d <= weekEnd;
    });
    console.log(`\n── verdict for Hubstaff email ${hubEmail}:`);
    console.log(`  history rows on this exact email: ${hist?.length ?? 0}`);
    console.log(`  history rows landing INSIDE ${WEEK}..${weekEnd} (after day 1): ${inWeek.length}`);
    if (!hist?.length) {
      console.log("  → NO history on the Hubstaff email = the engine can never prorate this person.");
    } else if (!inWeek.length) {
      console.log("  → history exists but no change lands inside the week = single-rate week, nothing to split.");
    } else {
      console.log("  → a mid-week change EXISTS; if no chip shows, check the individual-catalog skip above or daily columns.");
    }
  }
}
