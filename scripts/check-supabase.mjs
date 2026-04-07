import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const table = process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE || "global_master_list";

if (!url || !key) {
  console.log("Missing env vars: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY");
  process.exit(1);
}

const supabase = createClient(url, key);

// Columns in `global_master_list` (note spaces)
const select = 'Department,Name,"Personal Email","Start Date"';

const res = await supabase.from(table).select(select, { count: "exact" });

console.log(
  JSON.stringify(
    {
      table,
      len: res.data?.length ?? null,
      count: res.count ?? null,
      error: res.error ? { message: res.error.message, details: res.error.details } : null,
    },
    null,
    2,
  ),
);

