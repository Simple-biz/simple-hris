// Why does an employee's Pay Stubs export miss Tech/PAB bonuses on some weeks,
// and why do some weeks appear twice? Read-only probe over everything the
// /api/employee/paystub?all=1 assembly reads:
//   1. hubstaff_uploads — every source_file + its filename-parsed date range,
//      grouping files whose ranges overlap (the same pay week under 2+ names).
//   2. paystub_dispatch_queue — the person's staged payloads per source_file
//      (payload.pay_php.tech_bonus / perfect_attendance_bonus / final).
//   3. app_settings payroll.wizard.final_pay.<file> — the person's snapshot
//      entry (final, techBonus/perfectAttendanceBonus presence).
//   4. payment_dispatches — paid rows per cycle_source_file.
//   5. The tech-week rule (isTechBonusWeekSunSat, current partial-week-1 rule
//      AND the pre-Jul-2026 first-full-week rule) evaluated per week.
// Usage: node scripts/diagnose-paystub-weeks.mjs [email] [monthsBack]
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.local" });

const EMAIL = (process.argv[2] || "kaner@simple.biz").trim().toLowerCase();
const MONTHS_BACK = Number(process.argv[3] || 7);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) { console.error("missing supabase env"); process.exit(1); }
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

// ── filename → {start, end} (mirrors parseDateRangeFromFilename tolerance) ──
const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
function parseRange(name) {
  if (!name) return null;
  const s = name.toLowerCase();
  // "apr 5 - apr 11, 2026" / "jul 19 - jul 25 2026" style
  let m = /([a-z]{3})[a-z]*\s*(\d{1,2})\s*[-–_to]+\s*([a-z]{3})[a-z]*\s*(\d{1,2})[,\s_]*(\d{4})/.exec(s);
  if (m && MONTHS[m[1]] != null && MONTHS[m[3]] != null) {
    const y = Number(m[5]);
    const start = new Date(y, MONTHS[m[1]], Number(m[2]));
    let end = new Date(y, MONTHS[m[3]], Number(m[4]));
    if (end < start) end = new Date(y + 1, MONTHS[m[3]], Number(m[4]));
    return { start, end };
  }
  // "2026-04-05 - 2026-04-11"
  m = /(\d{4})-(\d{2})-(\d{2})\s*[-–_to]+\s*(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return { start: new Date(+m[1], +m[2] - 1, +m[3]), end: new Date(+m[4], +m[5] - 1, +m[6]) };
  return null;
}
const iso = (d) => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : "?";

// ── tech-week rules (Sun–Sat; salary = weekSunday + 8) ──
function techWeekSunSat(weekSunday, partialWeekCountsAsWeek1) {
  const salary = new Date(weekSunday.getFullYear(), weekSunday.getMonth(), weekSunday.getDate() + 8);
  const first = new Date(salary.getFullYear(), salary.getMonth(), 1);
  const dow = first.getDay();
  let firstSun;
  if (partialWeekCountsAsWeek1) {
    firstSun = new Date(first.getFullYear(), first.getMonth(), first.getDate() - dow);
  } else {
    // old rule: week 1 = first FULL Sun–Sat week
    firstSun = dow === 0 ? first : new Date(first.getFullYear(), first.getMonth(), first.getDate() + (7 - dow));
  }
  const third = new Date(firstSun.getFullYear(), firstSun.getMonth(), firstSun.getDate() + 14);
  const fourth = new Date(firstSun.getFullYear(), firstSun.getMonth(), firstSun.getDate() + 21);
  return salary >= third && salary < fourth;
}

const cutoff = new Date();
cutoff.setMonth(cutoff.getMonth() - MONTHS_BACK);

const [{ data: uploads, error: e1 }, { data: queueRows, error: e2 }, { data: dispatches, error: e3 }] = await Promise.all([
  sb.from("hubstaff_uploads").select("id, source_file, uploaded_at, row_count, is_current").order("uploaded_at", { ascending: false }).limit(2000),
  sb.from("paystub_dispatch_queue").select("cycle_source_file, recipient_email, locked_at, excluded, payload").eq("recipient_email", EMAIL).limit(1000),
  sb.from("payment_dispatches").select("cycle_source_file, status, sent_date, amount_php, amount_usd, created_at").eq("recipient_email", EMAIL).limit(1000),
]);
for (const [label, err] of [["uploads", e1], ["queue", e2], ["dispatches", e3]]) {
  if (err) { console.error(`${label} query failed:`, err.message); process.exit(1); }
}

// Distinct source files (the route de-dupes by name, so mirror that) in range.
const files = [];
const seen = new Set();
for (const u of uploads ?? []) {
  if (!u.source_file || seen.has(u.source_file)) continue;
  seen.add(u.source_file);
  const range = parseRange(u.source_file);
  if (range && range.end < cutoff) continue;
  files.push({ file: u.source_file, range, uploadedAt: u.uploaded_at, uploads: (uploads ?? []).filter(x => x.source_file === u.source_file).length });
}

const queueByFile = new Map((queueRows ?? []).map((r) => [r.cycle_source_file, r]));
const paidByFile = new Map();
for (const d of dispatches ?? []) {
  if (d.status !== "paid" || !d.cycle_source_file) continue;
  const list = paidByFile.get(d.cycle_source_file) ?? [];
  list.push(d);
  paidByFile.set(d.cycle_source_file, list);
}

// final_pay snapshots, one batched read.
const keys = files.map((f) => `payroll.wizard.final_pay.${f.file}`);
const snaps = new Map();
for (let i = 0; i < keys.length; i += 100) {
  const { data } = await sb.from("app_settings").select("key, value").in("key", keys.slice(i, i + 100));
  for (const row of data ?? []) snaps.set(row.key, row.value);
}

// Aliases: any email the snapshot finals might be keyed by.
const aliasSet = new Set([EMAIL]);
for (const r of queueRows ?? []) {
  const pe = r?.payload?.email;
  if (typeof pe === "string" && pe.trim()) aliasSet.add(pe.trim().toLowerCase());
}
const { data: masterRows } = await sb.from("employees").select("work_email, personal_email, alternate_work_email, alternate_work_email_2").or(`work_email.eq.${EMAIL},personal_email.eq.${EMAIL}`).limit(5);
for (const r of masterRows ?? []) for (const k of ["work_email", "personal_email", "alternate_work_email", "alternate_work_email_2"]) {
  if (r?.[k]) aliasSet.add(String(r[k]).trim().toLowerCase());
}
console.log(`Employee: ${EMAIL}  aliases: ${[...aliasSet].join(", ")}`);

function snapEntryFor(file) {
  const raw = snaps.get(`payroll.wizard.final_pay.${file}`);
  if (!raw) return { present: false };
  try {
    const parsed = JSON.parse(raw);
    const finals = parsed.finals ?? {};
    const lc = new Map(Object.entries(finals).map(([k, v]) => [k.trim().toLowerCase(), v]));
    for (const a of aliasSet) {
      const e = lc.get(a);
      if (e) return { present: true, entry: e };
    }
    return { present: true, entry: null };
  } catch { return { present: false }; }
}

files.sort((a, b) => (a.range && b.range ? a.range.start - b.range.start : 0));
console.log(`\n${files.length} distinct source files in the last ${MONTHS_BACK} months\n`);
const fmt = (n) => (n == null ? "  —  " : Number(n).toFixed(2));
let prev = null;
for (const f of files) {
  const q = queueByFile.get(f.file);
  const pay = q?.payload?.pay_php ?? null;
  const snap = snapEntryFor(f.file);
  const e = snap.entry;
  const paid = paidByFile.get(f.file) ?? [];
  const overlap = prev?.range && f.range && f.range.start <= prev.range.end && (prev.range.end - f.range.start) / 86400000 >= 3;
  const weekSunday = f.range ? (f.range.start.getDay() === 0 ? f.range.start : new Date(f.range.start.getFullYear(), f.range.start.getMonth(), f.range.start.getDate() - f.range.start.getDay())) : null;
  const techNew = weekSunday ? techWeekSunSat(weekSunday, true) : null;
  const techOld = weekSunday ? techWeekSunSat(weekSunday, false) : null;
  console.log(`${overlap ? "⚠ OVERLAPS PREV — SAME WEEK\n" : ""}${iso(f.range?.start)} → ${iso(f.range?.end)}  [${f.file}]  uploads:${f.uploads}${techNew ? "  TECH-WEEK(new-rule)" : ""}${techOld ? "  TECH-WEEK(old-rule)" : ""}`);
  console.log(`   staged: ${q ? `yes (locked:${q.locked_at ? "y" : "n"} excl:${q.excluded ? "y" : "n"})` : "no"}${pay ? `  pay_php{final:${fmt(pay.final)} tech:${fmt(pay.tech_bonus)} pab:${fmt(pay.perfect_attendance_bonus)} other:${fmt(pay.other_bonuses)}}` : ""}`);
  console.log(`   snapshot: ${snap.present ? (e ? `entry{final:${fmt(e.final)} initial:${fmt(e.initial)} tech:${e.techBonus === undefined ? "ABSENT" : fmt(e.techBonus)} pab:${e.perfectAttendanceBonus === undefined ? "ABSENT" : fmt(e.perfectAttendanceBonus)} other:${e.otherBonuses === undefined ? "ABSENT" : fmt(e.otherBonuses)}}` : "blob exists, NO ENTRY for this person") : "none"}`);
  console.log(`   paid dispatches: ${paid.length ? paid.map((p) => `${p.sent_date ?? "?"} ₱${fmt(p.amount_php)}`).join(" | ") : "none"}`);
  prev = f;
}
