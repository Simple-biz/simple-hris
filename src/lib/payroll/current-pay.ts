/**
 * Server-side calculator that turns the **latest Hubstaff upload** + the
 * `employee_hourly_rates` table into a per-employee pay summary that the
 * Payment Dispatch view shows to Lenny.
 *
 * Mirrors the bonus gates the wizard applies in Step 2:
 *  - PAB ₱5,000 on the final week of the PAB month, per-employee gated by
 *    perfect-attendance eligibility (standard or HSL variant).
 *  - Tech ₱1,850 on the salary-date-falls-in-3rd-week paycheck, per-employee
 *    gated by 30 days of service from `master.start_date`.
 *  - No-rates suppression: bonuses are 0 when the employee has neither a
 *    regular nor an OT rate.
 *
 * Department-specific bonuses (collections tiers, lead-gen) are NOT mirrored
 * — those depend on per-employee toggle state that lives only in the wizard's
 * browser session. See `src/lib/payroll/dispatch-bonuses.ts`.
 */
import {
  fetchHubstaffRowsOrdered,
  getCurrentHubstaffUploadId,
} from "@/lib/supabase/hubstaff-hours-db";
import { getEmployeeHourlyRatesRows } from "@/lib/supabase/employee-hourly-rates";
import { mapHubstaffHoursRow } from "@/lib/supabase/hubstaff-hours";
import { getAppSettings } from "@/lib/supabase/app-settings";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { listOrphanageBudgetRequests } from "@/lib/supabase/orphanage-budget-requests";
import { listGiftPayments } from "@/lib/supabase/gift-payments";
import { effectiveUsdToPhpRateFromStored } from "@/lib/fx/usd-php";
import { normEmail } from "@/lib/email/norm-email";
import {
  getPabMonthRange,
  parseDateRangeFromFilename,
  resolveCanonicalColumnsToIso,
} from "@/lib/hubstaff/calendar-column-dedupe";
import {
  PAB_PERIOD_OVERRIDES_KEY,
  parsePabPeriodOverrides,
  yearMonthKey,
} from "@/lib/pab-period-settings";
import {
  computeEmployeeBonus,
  computePabEligibleEmails,
  getHslAdjustedEnd,
  hasThirtyDaysFromStart,
  isFinalPabWeek as gateIsFinalPabWeek,
  isTechBonusWeek as gateIsTechBonusWeek,
  pabMonthFromWeekStart,
} from "@/lib/payroll/dispatch-bonuses";
import { fetchAllRateHistory, resolveRateAsOfDate, type RateHistoryByEmail } from "@/lib/payroll/rate-history";
import {
  US_HOLIDAYS_ENABLED_KEY,
  US_HOLIDAYS_LIST_KEY,
  parseUsHolidaysList,
  getEnabledHolidayMap,
} from "@/lib/us-holidays";

export interface PayrollPeriod {
  /** UUID of the active hubstaff_uploads row — null if no upload exists yet. */
  cycleId: string | null;
  /** ISO date (YYYY-MM-DD) — Sunday of the period, derived from Hubstaff date columns. */
  start: string | null;
  /** ISO date (YYYY-MM-DD) — Saturday of the period, derived from Hubstaff date columns. */
  end: string | null;
  /** Filename of the CSV that produced this upload, when available. */
  sourceFile: string | null;
}

export interface CurrentPayEntry {
  totalHours: number;
  regularHours: number;
  otHours: number;
  regularPayPHP: number | null;
  otPayPHP: number | null;
  /** Regular + OT only (no bonuses, no deductions). Kept for historical callers. */
  initialPayPHP: number | null;
  /** initialPayPHP / fxRate — null when either input is missing. */
  initialPayUSD: number | null;
  /** PAB ₱5,000 when final week of PAB month + eligible. */
  pabBonusPHP: number;
  /** Tech ₱1,850 when 3rd-week salary + 30-day service. */
  techBonusPHP: number;
  /** Sum of all bonuses. */
  bonusTotalPHP: number;
  /** ₱100 MESA contribution deducted from this employee's paycheck. 0 when not a member. */
  mesaDeductionPHP: number;
  /** Regular + OT + bonuses − MESA deduction — net amount Lenny pays this employee. */
  totalPayPHP: number | null;
  /** USD equivalent of totalPayPHP. */
  totalPayUSD: number | null;
  hasRate: boolean;
}

export interface CurrentPayResult {
  period: PayrollPeriod;
  fxRate: number;
  /** Keyed by lowercased work_email (the canonical join key). */
  byEmail: Record<string, CurrentPayEntry>;
  /** Total MESA contributions collected across all members this cycle (₱100 × count). */
  stashedMesaTotalPHP: number;
  /** Sum of final_amount across all approved orphanage budget requests. */
  approvedBudgetRequestsTotalPHP: number;
  /** Sum of pending/sent gift payments converted to PHP. */
  giftPaymentsTotalPHP: number;
}

function parseRateText(v: string | null | undefined): number | null {
  if (v == null) return null;
  const s = String(v).trim().replace(/,/g, "");
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fetch every Hubstaff row across all uploads. Required for PAB eligibility
 * — the rule needs the full PAB month so the standard variant can check every
 * Mon-Fri >= 7 h. We cannot safely filter by upload_id here because rows
 * imported before the upload_id FK migration have upload_id = NULL and would
 * be silently excluded, causing early-month days to show 0 h and breaking PAB.
 */
async function fetchAllHubstaffRowsForBonusMonth(
  supabase: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>,
): Promise<Record<string, unknown>[]> {
  const table =
    process.env.NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE?.trim() ||
    "hubstaff_hours";
  const PAGE = 1000;
  const out: Record<string, unknown>[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .range(from, from + PAGE - 1);
    if (error) {
      console.warn("[current-pay] fetchAllHubstaffRowsForBonusMonth failed:", error.message);
      return [];
    }
    const page = (data ?? []) as Record<string, unknown>[];
    out.push(...page);
    if (page.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

/**
 * Fetches ALL approved PAB disputes (status 'approved' or 'accounting_approved').
 * No date filter — the total volume is small (typically <100 rows) so fetching
 * everything upfront lets this run in the initial parallel batch without a
 * sequential dependency on knowing the PAB period date range.
 */
async function fetchAllApprovedDisputes(
  supabase: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>,
): Promise<Map<string, Map<string, number | null>>> {
  const { data, error } = await supabase
    .from("pab_day_disputes")
    .select("work_email, dispute_date, override_hours")
    .in("status", ["approved", "accounting_approved"]);
  if (error || !data) {
    console.warn("[current-pay] fetchAllApprovedDisputes failed:", error?.message);
    return new Map();
  }
  const map = new Map<string, Map<string, number | null>>();
  for (const row of data as Array<{ work_email: string; dispute_date: string; override_hours: number | null }>) {
    const email = normEmail(row.work_email) ?? (row.work_email ?? "").toLowerCase();
    if (!email) continue;
    if (!map.has(email)) map.set(email, new Map());
    map.get(email)!.set(row.dispute_date, row.override_hours);
  }
  return map;
}

interface MasterEmployeeMin {
  work_email: string | null;
  personal_email: string | null;
  start_date: string | null;
  department: string | null;
}

async function fetchMasterMin(
  supabase: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>,
): Promise<MasterEmployeeMin[]> {
  // active_employees view has the master columns we need (Work Email,
  // Personal Email, Start Date, Department). Quoted PascalCase column names.
  const { data, error } = await supabase
    .from("active_employees")
    .select('"Work Email", "Personal Email", "Start Date", "Department"');
  if (error || !data) {
    console.warn("[current-pay] fetchMasterMin failed:", error?.message);
    return [];
  }
  return (data as Array<Record<string, unknown>>).map((r) => ({
    work_email: typeof r["Work Email"] === "string" ? (r["Work Email"] as string) : null,
    personal_email:
      typeof r["Personal Email"] === "string" ? (r["Personal Email"] as string) : null,
    start_date:
      typeof r["Start Date"] === "string" ? (r["Start Date"] as string) : null,
    department:
      typeof r["Department"] === "string" ? (r["Department"] as string) : null,
  }));
}

/** Parse a YYYY-MM-DD or longer ISO string to a local Date, null on failure. */
// 40 hours/week regular cap, in seconds, mirroring member-monthly-pay.ts.
const REGULAR_WEEK_CAP_SEC = 40 * 3600;

const NON_DATE_COLS_FOR_DAILY = new Set([
  'id', 'organization', 'time zone', 'member', 'email', 'job title', 'job type',
  'employee id', 'tax info', 'location', 'date added', 'total worked', 'activity',
  'spent total', 'currency', 'source_file', 'upload_id',
]);

function isPerDayCol(col: string): boolean {
  const lower = col.trim().toLowerCase();
  if (NON_DATE_COLS_FOR_DAILY.has(lower)) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(col.trim());
}

function parseHmsToSec(v: unknown): number {
  if (v == null) return 0;
  const s = String(v).trim();
  if (!s) return 0;
  const hms = /^(\d+):(\d{2}):(\d{2})$/.exec(s);
  if (hms) return parseInt(hms[1], 10) * 3600 + parseInt(hms[2], 10) * 60 + parseInt(hms[3], 10);
  const hm = /^(\d+):(\d{2})$/.exec(s);
  if (hm) return parseInt(hm[1], 10) * 3600 + parseInt(hm[2], 10) * 60;
  const dec = parseFloat(s);
  return Number.isFinite(dec) ? Math.round(dec * 3600) : 0;
}

/**
 * Per-day prorated pay for a single hubstaff cycle row. Resolves the rate
 * as-of each day via the history table, applies the 40h/week regular cap
 * chronologically, and falls back to `fallbackRate` when no history row
 * is found for a date.
 *
 * Returns null when the row has no per-day ISO date columns (i.e. canonical
 * weekday CSV that couldn't be resolved) — caller should fall back to the
 * legacy single-rate × aggregate-hours formula in that case.
 */
function computeProratedRowPay(
  rowResolved: Record<string, unknown>,
  history: RateHistoryByEmail,
  email: string,
  fallbackRate: { reg: number | null; ot: number | null } | undefined,
): { regularPayPHP: number | null; otPayPHP: number | null } | null {
  const days: Array<{ date: Date; seconds: number }> = [];
  for (const [k, v] of Object.entries(rowResolved)) {
    if (!isPerDayCol(k)) continue;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k.trim());
    if (!m) continue;
    const sec = parseHmsToSec(v);
    if (sec <= 0) continue;
    days.push({ date: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), seconds: sec });
  }
  if (days.length === 0) return null;
  days.sort((a, b) => a.date.getTime() - b.date.getTime());

  const empHist = history.get(email);

  let usedRegSec = 0;
  let regularPayPHP = 0;
  let otPayPHP = 0;
  let anyRegRate = false;
  let anyOtRate = false;

  for (const d of days) {
    const resolved = resolveRateAsOfDate(empHist, d.date);
    const reg = resolved?.regularRate ?? fallbackRate?.reg ?? null;
    const ot = resolved?.otRate ?? fallbackRate?.ot ?? null;
    if (reg != null) anyRegRate = true;
    if (ot != null) anyOtRate = true;

    const remaining = Math.max(0, REGULAR_WEEK_CAP_SEC - usedRegSec);
    const dayRegSec = Math.min(d.seconds, remaining);
    const dayOtSec = d.seconds - dayRegSec;
    usedRegSec += dayRegSec;

    if (reg != null) regularPayPHP += (dayRegSec / 3600) * reg;
    if (ot != null) otPayPHP += (dayOtSec / 3600) * ot;
  }

  return {
    regularPayPHP: anyRegRate ? Math.round(regularPayPHP * 100) / 100 : null,
    otPayPHP: anyOtRate ? Math.round(otPayPHP * 100) / 100 : null,
  };
}

function parseLocalIso(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function computeCurrentPay(): Promise<CurrentPayResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  const cycleIdPromise = supabase
    ? getCurrentHubstaffUploadId(supabase)
    : Promise.resolve(null);

  const [
    hubstaff,
    rates,
    appSettings,
    cycleId,
    allHubstaffRows,
    masterRows,
    rateHistory,
    budgetRequestsResult,
    giftPaymentsResult,
    approvedDisputeDates,
  ] = await Promise.all([
    fetchHubstaffRowsOrdered(),
    getEmployeeHourlyRatesRows(),
    getAppSettings([
      "usd_to_php_rate",
      PAB_PERIOD_OVERRIDES_KEY,
      US_HOLIDAYS_ENABLED_KEY,
      US_HOLIDAYS_LIST_KEY,
    ]),
    cycleIdPromise,
    supabase
      ? fetchAllHubstaffRowsForBonusMonth(supabase)
      : Promise.resolve<Record<string, unknown>[]>([]),
    supabase ? fetchMasterMin(supabase) : Promise.resolve<MasterEmployeeMin[]>([]),
    fetchAllRateHistory(),
    listOrphanageBudgetRequests({ status: "approved" }),
    listGiftPayments({}),
    supabase
      ? fetchAllApprovedDisputes(supabase)
      : Promise.resolve(new Map<string, Map<string, number | null>>()),
  ]);

  const fxValue = appSettings["usd_to_php_rate"];
  const pabOverridesValue = appSettings[PAB_PERIOD_OVERRIDES_KEY];
  const usHolidaysEnabledValue = appSettings[US_HOLIDAYS_ENABLED_KEY];
  const usHolidaysListValue = appSettings[US_HOLIDAYS_LIST_KEY];

  const fxRate = effectiveUsdToPhpRateFromStored(fxValue);

  // Index rates by both work_email and personal_email (lowercased) so a
  // hubstaff row keyed on either still resolves to a rate.
  const rateByEmail = new Map<string, { reg: number | null; ot: number | null }>();
  const mesaEmails = new Set<string>();
  for (const r of rates.rows) {
    const reg = parseRateText(r.regular_rate);
    const ot = parseRateText(r.ot_rate);
    const we = normEmail(r.work_email);
    const pe = normEmail(r.personal_email);
    const entry = { reg, ot };
    if (we) rateByEmail.set(we, entry);
    if (pe && !rateByEmail.has(pe)) rateByEmail.set(pe, entry);
    if (r.mesa_member === true) {
      if (we) mesaEmails.add(we);
      if (pe) mesaEmails.add(pe);
    }
  }

  // ── Bonus prep ───────────────────────────────────────────────────────
  // 1. Determine the dispatch week's date range. Two paths:
  //    a) ISO-date columns on `hubstaff.columns` (some schemas have them).
  //    b) Fallback: parse the date range out of any row's `source_file`
  //       filename (e.g. `..._2026-04-26_to_2026-05-02.csv`). Hubstaff
  //       schemas that store canonical weekday columns rely on this.
  const dateColsIso = hubstaff.columns
    .filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c))
    .sort();
  let periodStartIso: string | null = dateColsIso[0] ?? null;
  let periodEndIso: string | null = dateColsIso[dateColsIso.length - 1] ?? null;
  if (!periodStartIso || !periodEndIso) {
    for (const r of hubstaff.rows) {
      const srcRaw = r.source_file;
      if (typeof srcRaw !== "string" || !srcRaw.trim()) continue;
      const range = parseDateRangeFromFilename(srcRaw);
      if (!range) continue;
      const fmt = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      periodStartIso = fmt(range.start);
      periodEndIso = fmt(range.end);
      break;
    }
  }
  const periodStart = parseLocalIso(periodStartIso);
  const periodEnd = parseLocalIso(periodEndIso);

  let pabRange: { start: Date; end: Date } | null = null;
  let hslAdjustedEnd: Date | null = null;
  let weekIsFinalPab = false;
  let weekIsTechBonus = false;
  let weekMonday: Date | null = null;

  if (periodStart) {
    const pabMonth = pabMonthFromWeekStart(periodStart);
    // Honor any manual override the wizard may have saved for this month;
    // fall back to the canonical Mon-week-on-or-after-the-1st range.
    const overrides = parsePabPeriodOverrides(pabOverridesValue);
    const overrideEntry = overrides.get(yearMonthKey(pabMonth.year, pabMonth.month));
    pabRange = overrideEntry
      ? { start: overrideEntry.start, end: overrideEntry.end }
      : getPabMonthRange(pabMonth.year, pabMonth.month);
    hslAdjustedEnd = getHslAdjustedEnd(pabRange.end);

    // The pay-period Monday is what the wizard checks against (not Sunday).
    const dow = periodStart.getDay();
    const daysBackToMon = dow === 0 ? 6 : dow - 1;
    weekMonday = new Date(
      periodStart.getFullYear(),
      periodStart.getMonth(),
      periodStart.getDate() - daysBackToMon,
    );

    if (periodEnd) {
      weekIsFinalPab = gateIsFinalPabWeek(periodEnd, pabRange.end);
    }
    weekIsTechBonus = gateIsTechBonusWeek(weekMonday);
  }

  // 2. Build HSL email set + start_date map from master.
  const hslEmails = new Set<string>();
  const startDateByEmail = new Map<string, Date>();
  for (const m of masterRows) {
    const we = normEmail(m.work_email);
    const pe = normEmail(m.personal_email);
    if (m.department && m.department.trim().toLowerCase() === "hsl") {
      if (we) hslEmails.add(we);
      if (pe) hslEmails.add(pe);
    }
    const sd = parseLocalIso(m.start_date);
    if (sd) {
      if (we) startDateByEmail.set(we, sd);
      if (pe && !startDateByEmail.has(pe)) startDateByEmail.set(pe, sd);
    }
  }

  // Build the US-holiday set for PAB forgiveness (same source the wizard uses).
  const usHolidayMap = getEnabledHolidayMap(
    parseUsHolidaysList(usHolidaysListValue),
    usHolidaysEnabledValue === "true",
  );
  const usHolidayDates = new Set(usHolidayMap.keys());

  // 3. Compute PAB eligibility from all Hubstaff rows merged by email
  //    across the PAB month.
  //
  // CRITICAL: rows from `hubstaff_hours` use canonical weekday columns
  // (`monday`, `tuesday`, ...) -- the actual calendar date is encoded in the
  // row's `source_file` filename (e.g. `..._2026-04-26_to_2026-05-02.csv`).
  // Each row must be passed through `resolveCanonicalColumnsToIso` so the
  // PAB eligibility check (which looks for ISO-date columns) actually sees
  // the daily hours.
  //
  // Approved PAB dispute overrides and US holiday forgiveness are fetched from
  // the DB and passed to `computePabEligibleEmails` so employees whose
  // PAB-failing days were forgiven by an approved dispute (or fell on a
  // US holiday) are correctly counted as eligible -- matching the wizard.
  const pabEligible = new Set<string>();
  if (pabRange && hslAdjustedEnd && weekIsFinalPab && allHubstaffRows.length > 0) {
    const merged = new Map<string, Record<string, unknown>>();
    for (const row of allHubstaffRows) {
      const rawEmail = String(row['Email'] ?? row['email'] ?? '').trim();
      const em = normEmail(rawEmail) ?? rawEmail.toLowerCase();
      if (!em) continue;
      const sourceFileForRow =
        typeof row['source_file'] === 'string' ? (row['source_file'] as string) : '';
      // Resolve canonical day columns to ISO dates using THIS row's filename.
      // Rows from different uploads each get their own resolution before merge.
      const resolved = sourceFileForRow
        ? resolveCanonicalColumnsToIso(row, sourceFileForRow)
        : row;

      const existing = merged.get(em);
      if (!existing) {
        merged.set(em, { ...resolved });
      } else {
        // Combine -- later (newer) uploads win on collision, but only when their
        // value is non-empty so an empty cell in this week doesn't clobber a
        // populated cell from another week.
        for (const [k, v] of Object.entries(resolved)) {
          if (v != null && String(v).trim() !== '') existing[k] = v;
        }
      }
    }
    const passes = computePabEligibleEmails({
      rows: Array.from(merged.values()),
      pabRange,
      hslAdjustedEnd,
      hslEmails,
      approvedDisputeDates,
      usHolidayDates,
    });
    for (const e of passes) pabEligible.add(e);
  }

  // ── Per-employee assembly ────────────────────────────────────────────
  const byEmail: Record<string, CurrentPayEntry> = {};
  let stashedMesaTotalPHP = 0;

  for (const raw of hubstaff.rows) {
    const mapped = mapHubstaffHoursRow(raw);
    const em = normEmail(mapped.email);
    if (!em) continue;

    const rate = rateByEmail.get(em);
    const totalHours = mapped.hoursDecimal;
    const otHours = mapped.overtimeDecimal;
    const regularHours = Math.max(0, totalHours - otHours);
    const reg = rate?.reg ?? null;
    const ot = rate?.ot ?? null;

    // Prorate pay per day using the rate-history table — handles mid-cycle
    // promotions / department transfers where the rate flipped on a specific
    // weekday. Falls back to the legacy single-rate formula when this row
    // has no per-day ISO columns (canonical weekday CSV that couldn't be
    // resolved to dates).
    const sourceFileForRow =
      typeof raw['source_file'] === 'string' ? (raw['source_file'] as string) : '';
    const rowResolved = sourceFileForRow
      ? resolveCanonicalColumnsToIso(raw, sourceFileForRow)
      : raw;
    const prorated = computeProratedRowPay(rowResolved, rateHistory, em, rate);

    let regularPayPHP: number | null;
    let otPayPHP: number | null;
    if (prorated) {
      regularPayPHP = prorated.regularPayPHP;
      otPayPHP = prorated.otPayPHP;
    } else {
      regularPayPHP = reg != null ? regularHours * reg : null;
      otPayPHP = ot != null ? otHours * ot : null;
    }
    const initialPayPHP =
      regularPayPHP != null && otPayPHP != null ? regularPayPHP + otPayPHP : null;

    // Bonus computation — gated by week + per-employee eligibility + has-rates.
    const hasRates = reg != null || ot != null;
    const startDate = startDateByEmail.get(em) ?? null;
    const empHasThirtyDays =
      weekMonday && startDate ? hasThirtyDaysFromStart(weekMonday, startDate) : false;

    const bonus = computeEmployeeBonus({
      hasRates,
      isFinalPabWeek: weekIsFinalPab,
      isPabEligible: pabEligible.has(em),
      isTechBonusWeek: weekIsTechBonus,
      hasThirtyDays: empHasThirtyDays,
    });

    // MESA: ₱100 deducted from members with a rates row. Accumulate into the
    // stash total so the dispatch screen can show the pool being built.
    const mesaDeductionPHP = hasRates && mesaEmails.has(em) ? 100 : 0;
    if (mesaDeductionPHP > 0) stashedMesaTotalPHP += mesaDeductionPHP;

    const totalPayPHP =
      initialPayPHP != null ? initialPayPHP + bonus.totalPHP - mesaDeductionPHP : null;
    const totalPayUSD =
      totalPayPHP != null && fxRate > 0 ? totalPayPHP / fxRate : null;
    const initialPayUSD =
      initialPayPHP != null && fxRate > 0 ? initialPayPHP / fxRate : null;

    byEmail[em] = {
      totalHours: Math.round(totalHours * 100) / 100,
      regularHours: Math.round(regularHours * 100) / 100,
      otHours: Math.round(otHours * 100) / 100,
      regularPayPHP: regularPayPHP != null ? Math.round(regularPayPHP * 100) / 100 : null,
      otPayPHP: otPayPHP != null ? Math.round(otPayPHP * 100) / 100 : null,
      initialPayPHP:
        initialPayPHP != null ? Math.round(initialPayPHP * 100) / 100 : null,
      initialPayUSD:
        initialPayUSD != null ? Math.round(initialPayUSD * 100) / 100 : null,
      pabBonusPHP: bonus.pabBonusPHP,
      techBonusPHP: bonus.techBonusPHP,
      bonusTotalPHP: bonus.totalPHP,
      mesaDeductionPHP,
      totalPayPHP: totalPayPHP != null ? Math.round(totalPayPHP * 100) / 100 : null,
      totalPayUSD: totalPayUSD != null ? Math.round(totalPayUSD * 100) / 100 : null,
      hasRate: reg != null,
    };
  }

  // source_file is repeated on every row in the current upload — sample one.
  const sourceFile = (() => {
    for (const r of hubstaff.rows) {
      const v = r.source_file;
      if (v != null && String(v).trim() !== "") return String(v).trim();
    }
    return null;
  })();

  const approvedBudgetRequestsTotalPHP = (budgetRequestsResult.rows ?? []).reduce(
    (sum, r) => sum + (r.final_amount ?? 0),
    0,
  );

  // Gift payments that haven't been cancelled are still obligations.
  const activeGiftPayments = (giftPaymentsResult.rows ?? []).filter(
    (r) => r.status !== "cancelled",
  );
  const giftPaymentsTotalPHP = activeGiftPayments.reduce(
    (sum, r) => sum + (r.total_usd ?? 0) * fxRate,
    0,
  );

  return {
    period: { cycleId, start: periodStartIso, end: periodEndIso, sourceFile },
    fxRate,
    byEmail,
    stashedMesaTotalPHP,
    approvedBudgetRequestsTotalPHP: Math.round(approvedBudgetRequestsTotalPHP * 100) / 100,
    giftPaymentsTotalPHP: Math.round(giftPaymentsTotalPHP * 100) / 100,
  };
}
