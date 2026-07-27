// Probe: replicate the readiness bank check's new "final pay out → age off"
// rule for the current pay week and list who it excludes vs. keeps.
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const sb = createClient(url, key);
const WEEK_START = process.argv[2] ?? "2026-07-19";
const SOURCE_FILE = process.argv[3] ?? "simple-biz_api_sync_2026-07-19_to_2026-07-25.csv";

const norm = (s) => (s ?? "").trim().toLowerCase();
const day = (s) => {
  const t = (s ?? "").trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t);
  if (mdy) {
    const y = mdy[3].length === 2 ? 2000 + Number(mdy[3]) : Number(mdy[3]);
    return `${y}-${String(mdy[1]).padStart(2, "0")}-${String(mdy[2]).padStart(2, "0")}`;
  }
  const d = new Date(t);
  return Number.isNaN(d.getTime())
    ? null
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function readAll(table, sel, filter) {
  const PAGE = 1000;
  const out = [];
  let from = 0;
  while (true) {
    let q = sb.from(table).select(sel).range(from, from + PAGE - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
    from += PAGE;
  }
  return out;
}

const active = await readAll("active_employees", 'Name,"Work Email","Personal Email",Department,"Start Date"');
const gmlOff = await readAll("global_master_list", '"Work Email","Personal Email",off_boarded_at', (q) =>
  q.not("off_boarded_at", "is", null),
);
const offSheet = await readAll("offboarded_sheet", "personal_email, work_email, off_boarded_at");
const queue = await readAll(
  "offboarding_queue",
  "employee_email, employee_work_email, employee_personal_email, decided_at",
  (q) => q.eq("status", "completed"),
);
const hub = await readAll("hubstaff_hours", "email", (q) => q.eq("source_file", SOURCE_FILE));

const evidence = new Map();
const add = (email, date) => {
  const e = norm(email);
  const d = day(date);
  if (!e || !d) return;
  const cur = evidence.get(e);
  if (!cur || d > cur) evidence.set(e, d);
};
for (const r of gmlOff) { add(r["Work Email"], r.off_boarded_at); add(r["Personal Email"], r.off_boarded_at); }
for (const r of offSheet) { add(r.work_email, r.off_boarded_at); add(r.personal_email, r.off_boarded_at); }
for (const r of queue) { add(r.employee_email, r.decided_at); add(r.employee_work_email, r.decided_at); add(r.employee_personal_email, r.decided_at); }

const payroll = new Set(hub.map((r) => norm(r.email)).filter(Boolean));
console.log(`week ${WEEK_START} · file ${SOURCE_FILE} · payroll emails ${payroll.size}`);

const excluded = [];
const keptFinalPay = [];
for (const a of active) {
  const w = norm(a["Work Email"]);
  const p = norm(a["Personal Email"]);
  const dates = [w, p].map((e) => (e ? evidence.get(e) : null)).filter(Boolean).sort();
  if (dates.length === 0) continue;
  const latest = dates[dates.length - 1];
  const started = day(a["Start Date"]);
  if (!(started && latest > started)) continue; // guard: not this stint's offboard
  const onPayroll = [w, p].some((e) => e && payroll.has(e));
  const row = `${a.Name} [${a.Department}] off=${latest} started=${started} onPayroll=${onPayroll}`;
  if (latest < WEEK_START && !onPayroll) excluded.push(row);
  else keptFinalPay.push(row);
}
console.log(`\nEXCLUDED by aging rule (${excluded.length}):`);
excluded.forEach((r) => console.log("  - " + r));
console.log(`\nKEPT with Left badge — final pay pending (${keptFinalPay.length}):`);
keptFinalPay.forEach((r) => console.log("  - " + r));
