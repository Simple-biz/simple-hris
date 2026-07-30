// Read-only diagnostic: how do the 6 Colombia-country hires appear in the
// dispatch pipeline (employee_ids, rates, staged queue, dispatches)?
// Usage: node scripts/diagnose-cop-people.mjs
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = createClient(url, key);

const PERSONAL = [
  "saveyahoney@gmail.com",
  "pilarcanas0519@gmail.com",
  "soniacaav@gmail.com",
  "juanruizr1992@gmail.com",
  "reynellruiz@gmail.com",
  "arturoyepes62@yahoo.com",
];

const orExpr = (col) => PERSONAL.map((e) => `${col}.ilike.${e}`).join(",");

// employee_ids: match personal email
const ids = await supabase
  .from("employee_ids")
  .select("name, work_email, personal_email, bank_preferred, preferred_processor, bank_name, account_number")
  .or(`${orExpr("personal_email")},${orExpr("work_email")}`);
console.log("── employee_ids ──");
console.log(ids.error ? ids.error.message : JSON.stringify(ids.data, null, 2));

const workEmails = new Set();
for (const r of ids.data ?? []) if (r.work_email) workEmails.add(r.work_email.trim().toLowerCase());

// rates rows
const rates = await supabase
  .from("employee_hourly_rates")
  .select("work_email, personal_email, department, regular_rate, ot_rate, bank_preferred")
  .or(`${orExpr("personal_email")},${orExpr("work_email")}`);
console.log("── employee_hourly_rates ──");
console.log(rates.error ? rates.error.message : JSON.stringify(rates.data, null, 2));
for (const r of rates.data ?? []) if (r.work_email) workEmails.add(r.work_email.trim().toLowerCase());

const allEmails = [...new Set([...PERSONAL, ...workEmails])];
console.log("── all emails ──", allEmails);

// staged queue rows, current cycle
const latest = await supabase
  .from("paystub_dispatch_queue")
  .select("cycle_source_file, created_at")
  .order("created_at", { ascending: false })
  .limit(1);
const sourceFile = latest.data?.[0]?.cycle_source_file ?? null;
console.log("── latest cycle ──", sourceFile);
if (sourceFile) {
  const staged = await supabase
    .from("paystub_dispatch_queue")
    .select("recipient_email, recipient_name, department_key, amount_php, amount_usd, excluded, sent_at")
    .eq("cycle_source_file", sourceFile)
    .in("recipient_email", allEmails);
  console.log("── staged rows this cycle ──");
  console.log(staged.error ? staged.error.message : JSON.stringify(staged.data, null, 2));
}

// dispatch history
const disp = await supabase
  .from("payment_dispatches")
  .select("recipient_email, recipient_name, processor, amount_usd, amount_php, amount_cop, status, sent_date, bank_used, recipient_preferred_bank")
  .in("recipient_email", allEmails)
  .order("created_at", { ascending: false })
  .limit(20);
console.log("── payment_dispatches ──");
console.log(disp.error ? disp.error.message : JSON.stringify(disp.data, null, 2));
