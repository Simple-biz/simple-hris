// READ-ONLY: full payload detail (pay_period, hours, pay_php, weekend) for the 10 transferees.
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.local" });

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL.trim(),
  process.env.SUPABASE_SERVICE_ROLE_KEY.trim(),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const WORK_EMAILS = [
  "betonioe@simple.biz", "galiciaa@simple.biz", "mariaga@simple.biz",
  "jeralyna@simple.biz", "raulpocholoa@simple.biz", "sherwinl@simple.biz",
  "roselyna@simple.biz", "jeorgiac@simple.biz", "sophiac@simple.biz",
  "roldand@simple.biz",
];
const FILE = "simple-biz_daily_report_2026-07-19_to_2026-07-25.csv";

const { data, error } = await sb
  .from("paystub_dispatch_queue")
  .select("recipient_email, payload")
  .eq("cycle_source_file", FILE)
  .in("recipient_email", WORK_EMAILS);
if (error) console.log("ERROR:", error.message);
for (const r of data ?? []) {
  const p = r.payload ?? {};
  console.log(JSON.stringify({
    recipient: r.recipient_email,
    pay_period: p.pay_period,
    hours: p.hours,
    pay_php: p.pay_php,
    rates_php: p.rates_php,
    weekend: p.weekend === undefined ? "<undefined>" : p.weekend,
    department_key: p.department_key,
    department_name: p.department_name,
  }));
}
