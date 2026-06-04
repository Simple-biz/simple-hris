import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const table = process.env.NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE || "hubstaff_hours";
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

// gotm@simple.biz CSV values: 05-10=2:19:05, 05-17=0:08:29, 05-03 wk?  beijayh 05-10=7:42:15,05-17=8:02:33
const files = [
  "simple-biz_daily_report_2026-05-03_to_2026-05-09.csv",
  "simple-biz_daily_report_2026-05-10_to_2026-05-17.csv",
  "simple-biz_daily_report_2026-05-17_to_2026-05-24.csv",
];
for (const f of files) {
  const { data } = await supabase
    .from(table).select('Email, sunday, monday, saturday')
    .eq("source_file", f).eq("Email", "gotm@simple.biz").maybeSingle();
  console.log(`${f}\n  gotm -> sunday=${data?.sunday}  monday=${data?.monday}  saturday=${data?.saturday}`);
}
