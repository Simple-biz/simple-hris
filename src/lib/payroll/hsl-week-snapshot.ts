/**
 * Pre-change "Sunday-to-Sunday" (Mon→Sun) snapshotter for HSL.
 *
 * Freezes the CURRENT Mon→Sun computed payroll/PAB output for every HSL
 * employee across ALL historical Hubstaff uploads into
 * `hsl_week_model_snapshot`, BEFORE the HSL week boundary is switched to
 * Sun→Sat (effective 2026-05-31).
 *
 * It deliberately reuses {@link computeCurrentPay} — the same engine Payment
 * Dispatch and the Payroll Wizard's mirror use — so the captured numbers are
 * byte-identical to what the app produces today. Run it BEFORE any cutover
 * code lands so the baseline is pure Mon→Sun.
 *
 * Idempotent: rows are upserted on (source_file, work_email, week_model).
 *
 * See references/sql/create/create_hsl_week_model_snapshot.sql.
 */
import { computeCurrentPay, type CurrentPayEntry } from "@/lib/payroll/current-pay";
import { listHubstaffUploads } from "@/lib/supabase/hubstaff-hours-db";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { getAppSettings } from "@/lib/supabase/app-settings";
import { normEmail } from "@/lib/email/norm-email";
import { selectAllPaged } from "@/lib/supabase/select-all-paged";
import { isHslFamilyLabel } from "@/lib/departments/hsl-subdept";
import {
  getPabMonthRange,
  payWeekFromUploadStart,
} from "@/lib/hubstaff/calendar-column-dedupe";
import {
  parseTechBonusWeekOverrides,
  resolveIsTechBonusWeek,
  TECH_BONUS_WEEK_OVERRIDES_KEY,
} from "@/lib/payroll/dispatch-bonuses";

export const HSL_WEEK_SNAPSHOT_TABLE = "hsl_week_model_snapshot";
export const PRE_CHANGE_WEEK_MODEL = "mon_sun" as const;

type ServiceClient = NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>;

function fmtDate(d: Date | null): string | null {
  if (!d) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseLocalIso(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(d.getTime()) ? null : d;
}

function yearMonthKey(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

/** Monday of the week containing `weekStart` (Mon→Sun owner month uses this). */
function pabMonthFromMonday(weekMonday: Date): { year: number; month: number } {
  const dow = weekMonday.getDay();
  const back = dow === 0 ? 6 : dow - 1;
  const mon = new Date(weekMonday.getFullYear(), weekMonday.getMonth(), weekMonday.getDate() - back);
  return { year: mon.getFullYear(), month: mon.getMonth() };
}

/**
 * The set of normalized emails (work + personal) of HSL employees, derived the
 * same way {@link computeCurrentPay} derives its internal `hslEmails` set
 * (any HSL-family `active_employees.Department` — 'HSL', 'Hogan Smith Law' or an
 * `hsl:<sub>` sub-team label). This is exactly the population that received
 * Mon→Sun pay windowing, so the snapshot captures the same people.
 */
export async function fetchHslEmailSet(supabase: ServiceClient): Promise<Set<string>> {
  // Paged: the roster passed 1,000 people and the dept filter runs in JS AFTER
  // the fetch, so PostgREST's silent 1,000-row cap dropped HSL people whose
  // rows sorted past it from the snapshot population.
  const { rows: data, error } = await selectAllPaged<Record<string, unknown>>((from, to) =>
    supabase
      .from("active_employees")
      .select('"Work Email", "Personal Email", "Department"')
      .order("Work Email", { ascending: true })
      .range(from, to),
  );
  const set = new Set<string>();
  if (error) {
    console.warn("[hsl-week-snapshot] fetchHslEmailSet failed:", error);
    return set;
  }
  for (const r of data) {
    const dept = typeof r["Department"] === "string" ? (r["Department"] as string) : "";
    if (!isHslFamilyLabel(dept)) continue;
    const we = normEmail(typeof r["Work Email"] === "string" ? (r["Work Email"] as string) : null);
    const pe = normEmail(typeof r["Personal Email"] === "string" ? (r["Personal Email"] as string) : null);
    if (we) set.add(we);
    if (pe) set.add(pe);
  }
  return set;
}

export interface SnapshotTarget {
  source_file: string;
  upload_id: string;
  uploaded_at: string;
  is_current: boolean;
  snapshotted: boolean;
  rows: number;
}

/**
 * List every historical upload and whether it has already been snapshotted,
 * so a caller can drive the backfill in chunks if the full run is too long for
 * one request.
 */
export async function listHslSnapshotTargets(): Promise<SnapshotTarget[]> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return [];
  const uploads = await listHubstaffUploads();

  // Count existing snapshot rows per source_file.
  const { data: existing } = await supabase
    .from(HSL_WEEK_SNAPSHOT_TABLE)
    .select("source_file")
    .eq("week_model", PRE_CHANGE_WEEK_MODEL);
  const counts = new Map<string, number>();
  for (const r of (existing ?? []) as Array<{ source_file: string }>) {
    counts.set(r.source_file, (counts.get(r.source_file) ?? 0) + 1);
  }

  const seen = new Set<string>();
  const targets: SnapshotTarget[] = [];
  for (const u of uploads) {
    const sf = (u.source_file ?? "").trim();
    if (!sf || seen.has(sf)) continue;
    seen.add(sf);
    targets.push({
      source_file: sf,
      upload_id: u.id,
      uploaded_at: u.uploaded_at,
      is_current: u.is_current,
      snapshotted: (counts.get(sf) ?? 0) > 0,
      rows: counts.get(sf) ?? 0,
    });
  }
  return targets;
}

export interface SnapshotFileResult {
  source_file: string;
  hslRowsWritten: number;
  payWeekStart: string | null;
  payWeekEnd: string | null;
  pabMonth: string | null;
  weekIsFinalPab: boolean;
  skippedReason?: string;
}

/**
 * Snapshot a single historical upload: compute Mon→Sun pay via
 * {@link computeCurrentPay}, keep only HSL employees, upsert the rows.
 */
export async function snapshotSourceFile(
  sourceFile: string,
  opts: { hslEmails?: Set<string>; capturedBy?: string | null; pabOverridesValue?: string | null; techWeekOverridesValue?: string | null } = {},
): Promise<SnapshotFileResult> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    return {
      source_file: sourceFile,
      hslRowsWritten: 0,
      payWeekStart: null,
      payWeekEnd: null,
      pabMonth: null,
      weekIsFinalPab: false,
      skippedReason: "SUPABASE_SERVICE_ROLE_KEY missing",
    };
  }

  const hslEmails = opts.hslEmails ?? (await fetchHslEmailSet(supabase));

  // Authoritative recompute for THIS week — same engine as Payment Dispatch.
  const pay = await computeCurrentPay({ sourceFile });

  // Per-file PAB context, derived exactly as current-pay.ts does.
  const periodStart = parseLocalIso(pay.period.start);
  const periodEnd = parseLocalIso(pay.period.end);
  // 'mon_sun' EXPLICITLY: weekMonday feeds resolveIsTechBonusWeek below, whose
  // override keys are owning MONDAYS — relying on the parameter default would
  // silently hand the gate a Sunday if that default ever flips to 'sun_sat'
  // (the pick would then fire a week late or never). Pinned by
  // tech-bonus-week.test.ts ("default week model stays mon_sun").
  const payWeekHsl = periodStart ? payWeekFromUploadStart(periodStart, true, 'mon_sun') : null;
  const weekMonday = payWeekHsl?.start ?? null;

  let pabMonthKey: string | null = null;
  let weekIsFinalPab = false;
  let weekIsTechBonus = false;
  if (weekMonday) {
    const pm = pabMonthFromMonday(weekMonday);
    pabMonthKey = yearMonthKey(pm.year, pm.month);
    // Honor a saved PAB-period override window the same way current-pay does, so
    // the recorded final-week flag matches the live dispatch decision.
    const overrides = parsePabOverrides(opts.pabOverridesValue);
    const ov = overrides.get(pabMonthKey);
    const pabRange = ov ?? getPabMonthRange(pm.year, pm.month);
    // Containment (mirror of dispatch-bonuses.isFinalPabWeek): the upload week
    // must CONTAIN the PAB period end, not merely end on/after it — otherwise
    // every week after the payout week re-attaches PAB.
    if (periodStart && periodEnd) {
      weekIsFinalPab =
        localMidnight(periodStart) <= localMidnight(pabRange.end) &&
        localMidnight(periodEnd) >= localMidnight(pabRange.end);
    }
    // Override-aware shared gate: a saved wizard "System Bonus" payout-week
    // pick must flag the same week here as computeCurrentPay pays, or the
    // recorded week_is_tech_bonus contradicts the money the row snapshots.
    weekIsTechBonus = resolveIsTechBonusWeek(
      weekMonday,
      parseTechBonusWeekOverrides(opts.techWeekOverridesValue),
    );
  }

  const rows: Record<string, unknown>[] = [];
  for (const [email, e] of Object.entries(pay.byEmail) as Array<[string, CurrentPayEntry]>) {
    if (!hslEmails.has(email)) continue; // HSL only — the only dept the change touches
    rows.push({
      week_model: PRE_CHANGE_WEEK_MODEL,
      source_file: sourceFile,
      upload_id: pay.period.cycleId,
      work_email: email,
      pay_week_start: fmtDate(payWeekHsl?.start ?? null),
      pay_week_end: fmtDate(payWeekHsl?.end ?? null),
      file_period_start: fmtDate(periodStart),
      file_period_end: fmtDate(periodEnd),
      pab_month: pabMonthKey,
      week_is_final_pab: weekIsFinalPab,
      week_is_tech_bonus: weekIsTechBonus,
      total_hours: e.totalHours,
      regular_hours: e.regularHours,
      ot_hours: e.otHours,
      regular_pay_php: e.regularPayPHP,
      ot_pay_php: e.otPayPHP,
      initial_pay_php: e.initialPayPHP,
      pab_bonus_php: e.pabBonusPHP,
      tech_bonus_php: e.techBonusPHP,
      bonus_total_php: e.bonusTotalPHP,
      total_pay_php: e.totalPayPHP,
      pay_currency: e.payCurrency,
      fx_rate: pay.fxRate,
      entry: e,
      captured_by: opts.capturedBy ?? null,
    });
  }

  if (rows.length > 0) {
    const { error } = await supabase
      .from(HSL_WEEK_SNAPSHOT_TABLE)
      .upsert(rows, { onConflict: "source_file,work_email,week_model" });
    if (error) {
      return {
        source_file: sourceFile,
        hslRowsWritten: 0,
        payWeekStart: fmtDate(payWeekHsl?.start ?? null),
        payWeekEnd: fmtDate(payWeekHsl?.end ?? null),
        pabMonth: pabMonthKey,
        weekIsFinalPab,
        skippedReason: `upsert failed: ${error.message}`,
      };
    }
  }

  return {
    source_file: sourceFile,
    hslRowsWritten: rows.length,
    payWeekStart: fmtDate(payWeekHsl?.start ?? null),
    payWeekEnd: fmtDate(payWeekHsl?.end ?? null),
    pabMonth: pabMonthKey,
    weekIsFinalPab,
  };
}

export interface SnapshotRunResult {
  weekModel: string;
  filesProcessed: number;
  totalHslRows: number;
  perFile: SnapshotFileResult[];
}

/**
 * Snapshot a set of uploads (or ALL of them when `sourceFiles` is omitted),
 * sequentially. The HSL email set and PAB overrides are fetched once and reused
 * across files.
 */
export async function runHslWeekSnapshot(
  opts: { sourceFiles?: string[]; capturedBy?: string | null } = {},
): Promise<SnapshotRunResult> {
  const supabase = createSupabaseServiceRoleClient();
  const perFile: SnapshotFileResult[] = [];
  if (!supabase) {
    return { weekModel: PRE_CHANGE_WEEK_MODEL, filesProcessed: 0, totalHslRows: 0, perFile };
  }

  const [hslEmails, settings] = await Promise.all([
    fetchHslEmailSet(supabase),
    getAppSettings(["pab_period_overrides", TECH_BONUS_WEEK_OVERRIDES_KEY]),
  ]);
  const pabOverridesValue = settings["pab_period_overrides"] ?? null;
  const techWeekOverridesValue = settings[TECH_BONUS_WEEK_OVERRIDES_KEY] ?? null;

  let files = opts.sourceFiles;
  if (!files || files.length === 0) {
    files = (await listHslSnapshotTargets()).map((t) => t.source_file);
  }

  let total = 0;
  for (const sf of files) {
    const res = await snapshotSourceFile(sf, {
      hslEmails,
      capturedBy: opts.capturedBy ?? null,
      pabOverridesValue,
      techWeekOverridesValue,
    });
    perFile.push(res);
    total += res.hslRowsWritten;
  }

  return {
    weekModel: PRE_CHANGE_WEEK_MODEL,
    filesProcessed: files.length,
    totalHslRows: total,
    perFile,
  };
}

/* ── local helpers (kept private; mirror dispatch-bonuses semantics) ────── */

function localMidnight(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Parse the pab_period_overrides JSON blob into a month→{start,end} map. */
function parsePabOverrides(value: string | null | undefined): Map<string, { start: Date; end: Date }> {
  const map = new Map<string, { start: Date; end: Date }>();
  if (!value || String(value).trim() === "") return map;
  try {
    const parsed = JSON.parse(value) as Record<string, { start?: string; end?: string }>;
    for (const [k, v] of Object.entries(parsed)) {
      if (!/^\d{4}-\d{2}$/.test(k) || !v || typeof v !== "object") continue;
      const s = parseLocalIso(v.start);
      const e = parseLocalIso(v.end);
      if (s && e && s.getTime() <= e.getTime()) map.set(k, { start: s, end: e });
    }
  } catch {
    /* malformed → empty */
  }
  return map;
}

// The Tech-bonus-week test used to be inlined here as a mirror of
// dispatch-bonuses.isTechBonusWeek. Once the payout week became configurable
// (tech_bonus_week_overrides), a frozen mirror would silently disagree with
// the engine paying the money, so the snapshot now imports the shared
// resolveIsTechBonusWeek instead.
