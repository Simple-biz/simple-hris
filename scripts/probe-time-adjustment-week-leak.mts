/**
 * READ-ONLY probe: are approved time adjustments credited to weeks they do not belong to?
 *
 * `timeAdjustDeltaByEmail` (PayrollWizard.tsx:6136) scopes the credit with
 * `allDaysColumnGroups`, whose own docstring says it is "All date-column groups within the
 * PAB RANGE" — a MONTH window, not the pay week. So an adjustment approved for one date can
 * be credited to every pay week inside the same PAB month.
 *
 * Usage: node --import tsx scripts/probe-time-adjustment-week-leak.mts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();
const { createSupabaseServiceRoleClient } = await import("../src/lib/supabase/server");
const { selectAllPaged } = await import("../src/lib/supabase/select-all-paged");
const { buildTimeAdjustmentDeltas } = await import("../src/lib/payroll-wizard/time-adjustment-week-scope");
const { approvedAdjustmentDayHours } = await import("../src/lib/payroll/approved-adjustment-hours");
const supabase = createSupabaseServiceRoleClient();
if (!supabase) { console.error("no client"); process.exit(1); }
const line = (s: string) => console.log(`\n${"─".repeat(78)}\n${s}\n${"─".repeat(78)}`);

type Final = {
  workEmail?: string;
  timeAdjustmentHours?: number | null;
  timeAdjustmentPay?: number | null;
  timeAdjustmentDays?: Array<{ date: string; hours: number }> | null;
  final?: number; initial?: number; regularPay?: number; otPay?: number;
};

function weekFromFile(f: string): { start: string; end: string } | null {
  const m = /(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})/.exec(f);
  return m ? { start: m[1], end: m[2] } : null;
}

line("1. every payroll.wizard.final_pay.* key — adjustments credited OUTSIDE the file's week");
const { rows: settings, error } = await selectAllPaged<{ key: string; value: unknown; updated_at: string }>((from, to) =>
  supabase.from("app_settings").select("key,value,updated_at").like("key", "payroll.wizard.final_pay.%").range(from, to));
if (error) console.log("  err", error);
console.log(`  ${settings.length} snapshot keys`);

let totalLeakPhp = 0;
const leakRows: Array<{ file: string; email: string; date: string; hours: number; pay: number }> = [];
for (const s of settings.sort((a, b) => a.key.localeCompare(b.key))) {
  const file = s.key.replace("payroll.wizard.final_pay.", "");
  const wk = weekFromFile(file);
  let parsed: unknown = s.value;
  for (let i = 0; i < 3 && typeof parsed === "string"; i++) { try { parsed = JSON.parse(parsed); } catch { break; } }
  const top = parsed as { finals?: unknown };
  const finalsRaw = top?.finals;
  const finals: Final[] = Array.isArray(finalsRaw) ? (finalsRaw as Final[])
    : finalsRaw && typeof finalsRaw === "object" ? (Object.values(finalsRaw) as Final[]) : [];
  const withAdj = finals.filter((f) => Number(f.timeAdjustmentPay ?? 0) !== 0 || (f.timeAdjustmentDays?.length ?? 0) > 0);
  if (withAdj.length === 0) continue;
  const outside: Final[] = [];
  for (const f of withAdj) {
    const days = f.timeAdjustmentDays ?? [];
    const bad = wk ? days.filter((d) => d.date < wk.start || d.date > wk.end) : days;
    if (bad.length) {
      outside.push(f);
      for (const d of bad) {
        leakRows.push({ file, email: String(f.workEmail), date: d.date, hours: d.hours, pay: Number(f.timeAdjustmentPay ?? 0) });
      }
    }
  }
  console.log(`\n  ${file}  week=${wk ? `${wk.start}..${wk.end}` : "UNPARSEABLE"}  updated=${s.updated_at}`);
  console.log(`      ${finals.length} finals · ${withAdj.length} carry a time adjustment · ${outside.length} carry a date OUTSIDE this week`);
  for (const f of outside) {
    const dates = (f.timeAdjustmentDays ?? []).map((d) => `${d.date}(${d.hours}h)`).join(" ");
    console.log(`        LEAK ${String(f.workEmail).padEnd(30)} ₱${Number(f.timeAdjustmentPay ?? 0).toFixed(2)} hrs=${f.timeAdjustmentHours} days=${dates}`);
    totalLeakPhp += Number(f.timeAdjustmentPay ?? 0);
  }
}

line("2. summary");
console.log(`  ${leakRows.length} (file, person, date) credits landed outside the file's own week`);
console.log(`  ₱${totalLeakPhp.toFixed(2)} of time-adjustment money sits on weeks it does not belong to`);

line("3. all approved time_adjustment_requests, for context");
{
  const { rows } = await selectAllPaged<Record<string, unknown>>((from, to) =>
    supabase.from("time_adjustment_requests").select("work_email,adjust_date,status,approved_hours,requested_hours,decided_at")
      .order("adjust_date", { ascending: false }).range(from, to));
  for (const r of rows) console.log(`  ${String(r.status).padEnd(9)} ${String(r.work_email).padEnd(30)} ${r.adjust_date} approved_hours=${r.approved_hours} requested=${r.requested_hours} decided=${r.decided_at}`);
  console.log(`  (${rows.length} rows)`);
}


line("4. the SHIPPED scope, re-run over the live rows for every snapshot week");
// Proof on real data, not fixtures: feed every approved request through the
// module the wizard now calls, once per pay week, and show what each week is
// allowed to credit. A week must only ever credit its own days.
{
  type Req = {
    work_email: string;
    adjust_date: string;
    status: string;
    approved_hours: number | null;
    requested_hours: number | null;
    requested_segments: unknown;
  };
  const { rows: reqs } = await selectAllPaged<Req>((from, to) =>
    supabase.from("time_adjustment_requests").select("*").eq("status", "approved").range(from, to),
  );
  // Tracked hours per (email, date) from every Hubstaff upload, PAGED — the
  // 1000-row cap on a 22k-row table is how an earlier audit read every tracked
  // figure as n/a (postgrest-1000-cap-sweep).
  const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
  const { rows: hub } = await selectAllPaged<Record<string, unknown>>((from, to) =>
    supabase.from("hubstaff_hours").select("*").range(from, to),
  );
  const { parseHoursToDecimal } = await import("../src/lib/supabase/hubstaff-hours");
  const rawByEmail = new Map<string, Map<string, number>>();
  for (const r of hub) {
    const em = String(r.Email ?? "").trim().toLowerCase();
    if (!em) continue;
    const wk = weekFromFile(String(r.source_file ?? ""));
    if (!wk) continue;
    const start = new Date(`${wk.start}T00:00:00`);
    if (!rawByEmail.has(em)) rawByEmail.set(em, new Map());
    const target = rawByEmail.get(em)!;
    DAYS.forEach((d, i) => {
      const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      const v = parseHoursToDecimal(r[d]);
      if (v > 0) target.set(iso, v);
    });
  }
  const approvedByEmail = new Map<string, Map<string, number>>();
  for (const r of reqs) {
    const em = (r.work_email ?? "").trim().toLowerCase();
    if (!em) continue;
    const trackedHours = rawByEmail.get(em)?.get(r.adjust_date) ?? 0;
    const dayHours = approvedAdjustmentDayHours(r, trackedHours);
    if (dayHours == null) continue;
    if (!approvedByEmail.has(em)) approvedByEmail.set(em, new Map());
    approvedByEmail.get(em)!.set(r.adjust_date, dayHours);
  }
  console.log(`  ${reqs.length} approved requests · ${approvedByEmail.size} people resolve to a day total`);
  const weeks = [...new Set(settings.map((s) => s.key.replace("payroll.wizard.final_pay.", "")))].sort();
  for (const file of weeks) {
    const wk = weekFromFile(file);
    const out = buildTimeAdjustmentDeltas({ approvedByEmail, rawByEmail, payWeek: wk ? { startKey: wk.start, endKey: wk.end } : null });
    if (out.size === 0) continue;
    console.log(`  ${file}`);
    for (const [em, d] of out) {
      const outside = d.days.filter((x) => !wk || x.date < wk.start || x.date > wk.end);
      console.log(`      ${em.padEnd(30)} ${d.hours.toFixed(4)}h  days=${d.days.map((x) => x.date).join(",")}  OUT-OF-WEEK=${outside.length}`);
    }
  }
  console.log("  (a week printing OUT-OF-WEEK>0 would be the defect; nothing should)");
}
