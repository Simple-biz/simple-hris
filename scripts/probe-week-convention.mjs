import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const table = process.env.NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE || "hubstaff_hours";
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const SRC = "simple-biz_daily_report_2026-05-10_to_2026-05-17.csv";
// emails where the two Sundays (05-10 vs 05-17) differ in the new CSV
const probes = {
  "gotm@simple.biz":     { d0510: "2:19:05", d0517: "0:08:29", mon0511: "8:35:22", sat0516: "1:04:39" },
  "angm@simple.biz":     { d0510: "7:50:51", d0517: "0:00:00", mon0511: "7:49:03", sat0516: "0:01:34" },
  "aubreyt@simple.biz":  { d0510: "8:11:27", d0517: "8:11:15", mon0511: "7:00:00", sat0516: "8:36:40" },
  "beijayh@simple.biz":  { d0510: "7:42:15", d0517: "8:02:33", mon0511: "8:09:28", sat0516: "0:00:00" },
};

const { data, error } = await supabase
  .from(table)
  .select('Email, monday, tuesday, wednesday, thursday, friday, saturday, sunday, "Total worked"')
  .eq("source_file", SRC)
  .in("Email", Object.keys(probes));

if (error) { console.log(error); process.exit(1); }

for (const r of data) {
  const p = probes[r.Email];
  console.log(`\n${r.Email}`);
  console.log(`  stored sunday   = ${r.sunday}   (CSV 05-10=${p.d0510}, 05-17=${p.d0517})`);
  console.log(`  stored monday   = ${r.monday}   (CSV 05-11=${p.mon0511})`);
  console.log(`  stored saturday = ${r.saturday}   (CSV 05-16=${p.sat0516})`);
}
