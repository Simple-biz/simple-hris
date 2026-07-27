// Probe: which ACTIVE roster people (the readiness bank list population) have
// offboard evidence somewhere, and where that evidence lives.
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config({ path: "c:/Users/Kane/Desktop/simple-hris/.env" });
dotenv.config({ path: "c:/Users/Kane/Desktop/simple-hris/.env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error("Missing env");
  process.exit(1);
}
const sb = createClient(url, key);

const norm = (s) => (s ?? "").trim().toLowerCase();

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

// 1. Active roster
const active = await readAll(
  "active_employees",
  'Name,"Work Email","Personal Email",Department,off_boarded_at',
);
console.log("active_employees:", active.length);

// 2. Offboard evidence sources
const gmlOff = await readAll(
  "global_master_list",
  'Name,"Work Email","Personal Email",off_boarded_at',
  (q) => q.not("off_boarded_at", "is", null),
);
console.log("gml offboarded rows:", gmlOff.length);

let offSheet = [];
try {
  offSheet = await readAll(
    "offboarded_sheet",
    "name, personal_email, work_email, off_boarded_at",
  );
} catch (e) {
  console.log("offboarded_sheet read failed:", e.message);
}
console.log("offboarded_sheet rows:", offSheet.length);

let queue = [];
try {
  queue = await readAll(
    "offboarding_queue",
    "employee_name, employee_email, employee_work_email, employee_personal_email, status, decided_at",
    (q) => q.eq("status", "completed"),
  );
} catch (e) {
  console.log("offboarding_queue read failed:", e.message);
}
console.log("offboarding_queue completed rows:", queue.length);

// Index evidence by email
const evidence = new Map(); // email -> {src, date}
const add = (email, src, date) => {
  const e = norm(email);
  if (!e) return;
  const cur = evidence.get(e) ?? [];
  cur.push({ src, date });
  evidence.set(e, cur);
};
for (const r of gmlOff) {
  add(r["Work Email"], "gml", r.off_boarded_at);
  add(r["Personal Email"], "gml", r.off_boarded_at);
}
for (const r of offSheet) {
  add(r.work_email, "sheet", r.off_boarded_at);
  add(r.personal_email, "sheet", r.off_boarded_at);
}
for (const r of queue) {
  add(r.employee_email, "queue", r.decided_at);
  add(r.employee_work_email, "queue", r.decided_at);
  add(r.employee_personal_email, "queue", r.decided_at);
}

// 3. Active people with offboard evidence (recent 60 days shown with dates)
const hits = [];
for (const a of active) {
  const emails = [a["Work Email"], a["Personal Email"]].map(norm).filter(Boolean);
  const ev = emails.flatMap((e) => evidence.get(e) ?? []);
  if (ev.length > 0) {
    hits.push({
      name: a.Name,
      dept: a.Department,
      work: a["Work Email"],
      evidence: ev.map((x) => `${x.src}:${(x.date ?? "").slice(0, 10)}`).join(", "),
    });
  }
}
console.log("\nACTIVE people with offboard evidence:", hits.length);
for (const h of hits.slice(0, 60)) {
  console.log(`- ${h.name} [${h.dept}] ${h.work ?? ""} -> ${h.evidence}`);
}
