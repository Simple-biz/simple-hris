// Read-only probe round 2
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config({ path: "c:/Users/Kane/Desktop/simple-hris/.env" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const EMAIL = "vano@simple.biz";

async function q(label, fn) {
  const { data, error, count } = await fn();
  if (error) { console.log(`\n--- ${label}: ERROR ${error.message}`); return null; }
  console.log(`\n--- ${label}: ${Array.isArray(data) ? data.length + " row(s)" : "ok"}${count != null ? ` count=${count}` : ""}`);
  if (data) console.log(JSON.stringify(data, null, 1));
  return data;
}

// 1. hubstaff hours for vano, recent files
await q("hubstaff_hours vano recent", () =>
  supabase.from("hubstaff_hours").select('"Member","Email","Total worked",source_file,upload_id')
    .ilike("Email", EMAIL)
    .order("source_file", { ascending: false })
    .limit(10));

// 2. anyone in the Jul-19..25 file? confirm file name pattern
await q("hubstaff_hours file names like 07-19", () =>
  supabase.from("hubstaff_hours").select("source_file")
    .ilike("source_file", "%2026-07-19%").limit(3));

// 3. count rows in the Jul-19 file
await q("count Jul-19 file rows", () =>
  supabase.from("hubstaff_hours").select("id", { count: "exact", head: true })
    .ilike("source_file", "%2026-07-19%"));

// 4. vano row in the Jul-19 file specifically
await q("vano in Jul-19 file", () =>
  supabase.from("hubstaff_hours").select("*")
    .ilike("source_file", "%2026-07-19%").ilike("Email", EMAIL));

// 5. active_employees schema peek
await q("active_employees sample", () =>
  supabase.from("active_employees").select("*").limit(1));

// 6. latest master list upload ids
await q("master_list_uploads sample", () =>
  supabase.from("master_list_uploads").select("*").order("uploaded_at", { ascending: false }).limit(5));
