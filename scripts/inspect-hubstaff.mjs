import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const table = process.env.NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE || "hubstaff_hours";

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

// 1. uploads archive
const ups = await supabase
  .from("hubstaff_uploads")
  .select("id, source_file, uploaded_at, row_count, is_current")
  .order("uploaded_at", { ascending: false });
console.log("=== hubstaff_uploads (newest first) ===");
console.log(JSON.stringify(ups.data ?? ups.error, null, 2));

// 2. one sample row to learn columns
const sample = await supabase.from(table).select("*").limit(1);
console.log("\n=== hubstaff_hours columns ===");
console.log(sample.data?.[0] ? Object.keys(sample.data[0]) : sample.error);

// 3. distinct source_file values + counts
const all = [];
let from = 0;
while (true) {
  const { data, error } = await supabase
    .from(table)
    .select("source_file, upload_id")
    .range(from, from + 999);
  if (error) { console.log(error); break; }
  all.push(...data);
  if (data.length < 1000) break;
  from += 1000;
}
const byFile = {};
for (const r of all) {
  const k = `${r.source_file ?? "(null)"} | upload=${r.upload_id ?? "(null)"}`;
  byFile[k] = (byFile[k] ?? 0) + 1;
}
console.log("\n=== row counts by (source_file | upload_id) ===");
console.log(JSON.stringify(byFile, null, 2));
console.log("\ntotal rows:", all.length);
