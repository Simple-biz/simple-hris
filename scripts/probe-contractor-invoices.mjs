// READ-ONLY probe: is the contractor_invoices table receiving invoices,
// and would the Payroll Wizard's pay-period filter show or hide them?
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: "c:/Users/Kane/Desktop/simple-hris/.env" });
dotenv.config({ path: "c:/Users/Kane/Desktop/simple-hris/.env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) { console.log("Missing Supabase env vars"); process.exit(1); }

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

// 1) Full table scan (it should be small) — every column so we can also see
//    whether payment_method exists.
const { data, error, count } = await supabase
  .from("contractor_invoices")
  .select("*", { count: "exact" })
  .order("created_at", { ascending: false });

if (error) {
  console.log("QUERY ERROR:", JSON.stringify({ message: error.message, details: error.details, hint: error.hint }));
  process.exit(1);
}

console.log(`total rows: ${count}`);
if (!data?.length) { console.log("Table is EMPTY — no invoices have ever been stored."); process.exit(0); }

console.log("columns present:", Object.keys(data[0]).join(", "));

// 2) Status breakdown
const byStatus = {};
for (const r of data) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
console.log("status breakdown:", JSON.stringify(byStatus));

// 3) Row-by-row: invoice_date vs created_at (the wizard filters on
//    invoice_date || created_at, sliced to YYYY-MM-DD, within the Sun–Sat
//    pay-period window parsed from the Hubstaff CSV filename).
console.log("\nrows (newest first):");
for (const r of data) {
  console.log(
    [
      r.created_at?.slice(0, 10),
      `inv_date=${r.invoice_date ?? "NULL"}`,
      `status=${r.status}`,
      `${r.currency} ${r.total}`,
      r.contractor_email,
      `#${r.invoice_number}`,
      `pm=${r.payment_method ? (r.payment_method.processor ?? "obj") : "NULL"}`,
    ].join(" | ")
  );
}

// 4) Simulate the wizard's window for recent Sun–Sat weeks: which invoices
//    would each week's Contractors step show?
function keyOf(r) { return (r.invoice_date || r.created_at || "").slice(0, 10); }
function fmt(d) { return d.toISOString().slice(0, 10); }
// last 6 Sun–Sat weeks ending before today (2026-07-27 is a Monday)
const weeks = [];
let end = new Date(Date.UTC(2026, 6, 25)); // Sat Jul 25 2026
for (let i = 0; i < 6; i++) {
  const start = new Date(end); start.setUTCDate(end.getUTCDate() - 6);
  weeks.push({ startKey: fmt(start), endKey: fmt(end) });
  end = new Date(end); end.setUTCDate(end.getUTCDate() - 7);
}
console.log("\nwizard-visibility simulation (Sun–Sat weeks):");
for (const w of weeks.reverse()) {
  const inWin = data.filter((r) => { const k = keyOf(r); return k && k >= w.startKey && k <= w.endKey; });
  console.log(`  ${w.startKey}..${w.endKey}: ${inWin.length} invoice(s)` +
    (inWin.length ? ` [${inWin.map((r) => `${r.contractor_email}:${r.status}`).join(", ")}]` : ""));
}

// 5) Invoices dated AFTER the most recent completed week (would be invisible
//    when running last week's payroll)
const latestEnd = "2026-07-25";
const after = data.filter((r) => keyOf(r) > latestEnd);
console.log(`\ninvoices dated after ${latestEnd} (invisible when paying the Jul 19–25 week): ${after.length}`);
for (const r of after) console.log(`  ${keyOf(r)} | ${r.status} | ${r.contractor_email} | ${r.currency} ${r.total}`);
