// READ-ONLY evidence probe: Jul-20 into-HSL transferees vs the
// simple-biz_daily_report_2026-07-19_to_2026-07-25.csv Hubstaff file.
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) { console.error("missing supabase env"); process.exit(1); }
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const WORK_EMAILS = [
  "betonioe@simple.biz", "galiciaa@simple.biz", "mariaga@simple.biz",
  "jeralyna@simple.biz", "raulpocholoa@simple.biz", "sherwinl@simple.biz",
  "roselyna@simple.biz", "jeorgiac@simple.biz", "sophiac@simple.biz",
  "roldand@simple.biz",
];
const FILE = "simple-biz_daily_report_2026-07-19_to_2026-07-25.csv";

// ── 1) master list rows (current dept + personal-email aliases)
const { data: master, error: mErr } = await sb
  .from("global_master_list")
  .select('"Name", "Department", "Work Email", "Personal Email"')
  .in('"Work Email"', WORK_EMAILS);
console.log("== global_master_list ==", mErr?.message ?? "");
for (const r of master ?? []) {
  console.log(JSON.stringify({ name: r["Name"], dept: r["Department"], work: r["Work Email"], personal: r["Personal Email"] }));
}

const allEmails = new Set(WORK_EMAILS);
for (const r of master ?? []) {
  const p = (r["Personal Email"] || "").trim().toLowerCase();
  if (p) allEmails.add(p);
}

// ── 2) hubstaff rows for the file (Email match on any alias)
const { data: hub, error: hErr } = await sb
  .from("hubstaff_hours")
  .select('"Member", "Email", monday, tuesday, wednesday, thursday, friday, saturday, sunday, source_file, upload_id')
  .eq("source_file", FILE)
  .in('"Email"', [...allEmails]);
console.log("\n== hubstaff_hours (email match) ==", hErr?.message ?? "");
for (const r of hub ?? []) console.log(JSON.stringify(r));

// also try Member-name match for anyone with no email hit (hubstaff email may be a 3rd alias)
const hitEmails = new Set((hub ?? []).map((r) => (r["Email"] || "").trim().toLowerCase()));
const missing = (master ?? []).filter((m) => {
  const w = (m["Work Email"] || "").trim().toLowerCase();
  const p = (m["Personal Email"] || "").trim().toLowerCase();
  return !hitEmails.has(w) && !hitEmails.has(p);
});
console.log("\n== name-based retry for people with no email hit ==");
for (const m of missing) {
  const parts = String(m["Name"] || "").replace(/[",]/g, " ").split(/\s+/).filter(Boolean);
  if (!parts.length) continue;
  const pat = `%${parts.join("%")}%`;
  const { data: byName } = await sb
    .from("hubstaff_hours")
    .select('"Member", "Email", monday, tuesday, wednesday, thursday, friday, saturday, sunday, upload_id')
    .eq("source_file", FILE)
    .ilike("Member", pat);
  if (byName?.length) for (const r of byName) console.log("NAME-HIT", m["Name"], JSON.stringify(r));
  else console.log("NO-HUBSTAFF-ROW", m["Name"], m["Work Email"]);
}

// ── 3) staged payloads
const { data: staged, error: sErr } = await sb
  .from("paystub_dispatch_queue")
  .select("recipient_email, cycle_source_file, payload")
  .eq("cycle_source_file", FILE)
  .in("recipient_email", [...allEmails]);
console.log("\n== paystub_dispatch_queue (exact cycle_source_file) ==", sErr?.message ?? "");
const summarize = (r) => {
  const p = r.payload ?? {};
  return {
    recipient: r.recipient_email,
    cycle_source_file: r.cycle_source_file,
    department_key: p.department_key ?? p.departmentKey ?? p.department ?? null,
    weekend: p.weekend === undefined ? "<undefined>" : p.weekend,
    regular_hours: p.regular_hours ?? p.regularHours ?? null,
    ot_hours: p.ot_hours ?? p.overtime_hours ?? p.otHours ?? null,
    total: p.total ?? p.total_pay ?? p.totalPay ?? null,
    period: p.period ?? p.week ?? p.period_label ?? null,
    topKeys: Object.keys(p).slice(0, 40),
  };
};
for (const r of staged ?? []) console.log(JSON.stringify(summarize(r)));
if (!staged?.length) {
  const { data: staged2 } = await sb
    .from("paystub_dispatch_queue")
    .select("recipient_email, cycle_source_file, payload")
    .ilike("cycle_source_file", "%2026-07-19_to_2026-07-25%")
    .in("recipient_email", [...allEmails]);
  console.log("-- fallback ilike cycle_source_file --");
  for (const r of staged2 ?? []) console.log(JSON.stringify(summarize(r)));
}

// ── 4) HSL week-model cutover setting
const { data: setting, error: aErr } = await sb
  .from("app_settings")
  .select("*")
  .eq("key", "hsl.week_model_cutover");
console.log("\n== app_settings hsl.week_model_cutover ==", aErr?.message ?? "");
console.log(JSON.stringify(setting));

// ── 5) what dates do the day columns represent for this file?
console.log("\n== filename range sanity ==");
console.log("2026-07-19 is a", new Date(2026, 6, 19).toDateString());
console.log("2026-07-25 is a", new Date(2026, 6, 25).toDateString());
