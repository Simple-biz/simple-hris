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
  fetchHubstaffRowsBySourceFile,
  getCurrentHubstaffUploadId,
  getHubstaffUploadIdBySourceFile,
} from "@/lib/supabase/hubstaff-hours-db";
import { getEmployeeHourlyRatesRows } from "@/lib/supabase/employee-hourly-rates";
import { mapHubstaffHoursRow } from "@/lib/supabase/hubstaff-hours";
import { getAppSettings } from "@/lib/supabase/app-settings";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { listOrphanageBudgetRequests } from "@/lib/supabase/orphanage-budget-requests";
import { listAllOrphanagePayHours } from "@/lib/supabase/orphanage-pay-db";
import { buildOrphanageCoverageMap } from "@/lib/payroll/orphanage-pab-coverage";
import { buildFxRates, USD_TO_COP_SETTINGS_KEY, type FxRates } from "@/lib/fx/currency-fx";
import { normEmail } from "@/lib/email/norm-email";
import { applyDeptOverrideToRawRow } from "@/lib/departments/dept-email-overrides";
import {
  getPabMonthRange,
  parseDateRangeFromFilename,
  payWeekFromUploadStart,
  resolveCanonicalColumnsToIso,
} from "@/lib/hubstaff/calendar-column-dedupe";
import {
  PAB_PERIOD_OVERRIDES_KEY,
  PAB_PERIOD_EXCLUSIONS_KEY,
  parsePabPeriodOverrides,
  parsePabPeriodExclusions,
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
import {
  HSL_WEEK_MODEL_CUTOVER_KEY,
  resolveHslWeekModelWithDefault,
  type HslWeekModel,
} from "@/lib/payroll/hsl-week-model";
import { fetchAllRateHistory, resolveRateAsOfDate, type RateHistoryByEmail } from "@/lib/payroll/rate-history";
import { listPayStructures } from "@/lib/supabase/pay-structures-db";
import { listSystemBonuses } from "@/lib/supabase/system-bonuses-db";
import { resolveSystemBonuses, isDeptEligible, systemBonusAmountForDept } from "@/lib/payment-catalog/system-bonus";
import { normalizeDeptToKey } from "@/lib/payroll/normalize-dept-key";
import { DEPARTMENTS } from "@/lib/payroll/department-bonus";
import type { PayCurrency } from "@/lib/payment-catalog/pay-structure";
import {
  buildCatalogRateIndex,
  resolveEmployeeCatalogRate,
  resolveDeptCatalogRate,
} from "@/lib/payroll/resolve-rate";
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
  /** Native COP payout (whole pesos), derived from the USD anchor (totalPayUSD ×
   *  usdToCop). Only meaningful when `payCurrency === 'COP'`; null when totalPayUSD
   *  is missing. Payment Dispatch reads this for the COP tab. */
  totalPayCOP: number | null;
  hasRate: boolean;
  /**
   * The currency this employee's EFFECTIVE rate is denominated in (Payment
   * Catalog). 'USD' / 'COP' when an individual/department structure in that
   * currency drives their rate; 'PHP' otherwise (sheet rates are always PHP).
   * Pay math still accumulates in PHP — this only flags who should be PAID in a
   * non-PHP currency so Payment Dispatch can route them to a dedicated tab. For a
   * USD employee `totalPayUSD` is their native pay; for COP `totalPayCOP` is
   * (totalPayPHP is the FX-equivalent in both cases).
   */
  payCurrency: PayCurrency;
  /**
   * Payroll department for this payee, resolved from the best available source
   * (Global Master List first, then the rates-row "Department"). `departmentKey`
   * is the normalized canonical key (null when the raw value maps to no known
   * department); `departmentName` is the human label — the canonical name when
   * the key resolved, else the raw source string so nothing is lost. Payment
   * Dispatch reads these so EVERY payee shows their department, not just HSL.
   */
  departmentKey: string | null;
  departmentName: string | null;
}

export interface CurrentPayResult {
  period: PayrollPeriod;
  /** USD→PHP rate (PHP per $1). Kept for back-compat; see `fxRates` for the full set. */
  fxRate: number;
  /** All USD-anchored rates (usdToPhp + usdToCop) used this run. */
  fxRates: FxRates;
  /** Keyed by lowercased work_email (the canonical join key). */
  byEmail: Record<string, CurrentPayEntry>;
  /** Total MESA contributions collected across all members this cycle (₱100 × count). */
  stashedMesaTotalPHP: number;
  /** Sum of final_amount across all approved orphanage budget requests. */
  approvedBudgetRequestsTotalPHP: number;
  /**
   * Every email (work + personal + alternates, lowercased) present in the
   * Global Master List (`active_employees`). The dispatch queue filters to these
   * so it never shows people who aren't on the master list to begin with.
   */
  masterEmails: string[];
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

/**
 * Fetches ALL approved time adjustments and overlays them onto the supplied dispute map
 * (time adjustments win on a same day). Used so an employee's PAB eligibility reflects
 * accounting-corrected hours. Never touches hubstaff_hours — hours are overlaid at calc time.
 */
async function mergeApprovedTimeAdjustments(
  supabase: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>,
  map: Map<string, Map<string, number | null>>,
): Promise<Map<string, Map<string, number | null>>> {
  const { data, error } = await supabase
    .from("time_adjustment_requests")
    .select("work_email, adjust_date, approved_hours")
    .eq("status", "approved");
  if (error || !data) return map;
  for (const row of data as Array<{ work_email: string; adjust_date: string; approved_hours: number | null }>) {
    if (row.approved_hours == null) continue;
    const email = normEmail(row.work_email) ?? (row.work_email ?? "").toLowerCase();
    if (!email) continue;
    if (!map.has(email)) map.set(email, new Map());
    map.get(email)!.set(row.adjust_date, row.approved_hours);
  }
  return map;
}

interface MasterEmployeeMin {
  work_email: string | null;
  personal_email: string | null;
  /** Gsuite aliases for the same human (Global Master List columns). Bridged
   *  into the start-date lookup so a Hubstaff row keyed on an alias still
   *  resolves the Tech Bonus 30-day-service gate. */
  alternate_work_email: string | null;
  alternate_work_email_2: string | null;
  start_date: string | null;
  department: string | null;
}

async function fetchMasterMin(
  supabase: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>,
): Promise<MasterEmployeeMin[]> {
  // active_employees view has the master columns we need (Work Email,
  // Personal Email, Alternate Work Email(s), Start Date, Department).
  // Quoted PascalCase column names.
  // PostgREST caps a plain `.select()` at 1000 rows (db.max-rows on this
  // project). active_employees exceeds 1000, so an un-paginated read silently
  // dropped every master employee past row 1000. Those people then failed the
  // Payment Dispatch `inMaster` gate and vanished from the queue entirely —
  // despite having hours and a valid pay computation. Paginate until a short
  // page, exactly like getEmployeeHourlyRatesRows.
  const PAGE = 1000;
  const raw: Array<Record<string, unknown>> = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("active_employees")
      .select(
        '"Work Email", "Personal Email", "Alternate Work Email", "Alternate Work Email 2", "Start Date", "Department"',
      )
      .range(from, from + PAGE - 1);
    if (error) {
      console.warn("[current-pay] fetchMasterMin failed:", error.message);
      // Return whatever pages we already pulled — a partial master set still
      // beats blanking the queue. An empty result makes the caller fail open
      // (inMaster shows everyone) rather than silently drop people.
      break;
    }
    const page = (data ?? []) as Array<Record<string, unknown>>;
    raw.push(...page);
    if (page.length < PAGE) break;
    from += PAGE;
  }
  // applyDeptOverrideToRawRow: effective department (Sales/Sales-Assistant
  // email split) — keeps the PH cohort's PAB/Tech eligibility + dept key on
  // the sales_assistant side of the split.
  return raw.map(applyDeptOverrideToRawRow).map((r) => ({
    work_email: typeof r["Work Email"] === "string" ? (r["Work Email"] as string) : null,
    personal_email:
      typeof r["Personal Email"] === "string" ? (r["Personal Email"] as string) : null,
    alternate_work_email:
      typeof r["Alternate Work Email"] === "string" ? (r["Alternate Work Email"] as string) : null,
    alternate_work_email_2:
      typeof r["Alternate Work Email 2"] === "string"
        ? (r["Alternate Work Email 2"] as string)
        : null,
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
 *
 * Exported so the disbursement-report seeding path
 * (`seedMissingDisbursementRecords`) computes pending-cycle estimates with the
 * exact same rate-history prorating, 40h cap and HSL weekend premium as the
 * live dispatch — the two can never silently diverge.
 */
export function computeProratedRowPay(
  rowResolved: Record<string, unknown>,
  history: RateHistoryByEmail,
  email: string,
  fallbackRate: { reg: number | null; ot: number | null } | undefined,
  isHsl?: boolean,
  /** When given, only days within [start, end] (inclusive, local) are counted —
   *  the department's 7-day pay week, so an 8-day Sun→Sun upload contributes
   *  exactly one week. */
  payWindow?: { start: Date; end: Date } | null,
  /** Catalog override (PHP-equivalent). When present, the Payment Catalog is the
   *  source of truth: every day is paid at this rate, bypassing the per-day rate
   *  history. Absent → resolve per-day from history with `fallbackRate`. */
  rateOverride?: { reg: number | null; ot: number | null } | null,
): {
  regularPayPHP: number | null;
  otPayPHP: number | null;
  totalSec: number;
  regularSec: number;
  otSec: number;
} | null {
  const winLo = payWindow
    ? new Date(payWindow.start.getFullYear(), payWindow.start.getMonth(), payWindow.start.getDate()).getTime()
    : null;
  const winHi = payWindow
    ? new Date(payWindow.end.getFullYear(), payWindow.end.getMonth(), payWindow.end.getDate()).getTime()
    : null;

  const days: Array<{ date: Date; seconds: number }> = [];
  for (const [k, v] of Object.entries(rowResolved)) {
    if (!isPerDayCol(k)) continue;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k.trim());
    if (!m) continue;
    const sec = parseHmsToSec(v);
    if (sec <= 0) continue;
    const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (winLo != null && winHi != null) {
      const t = date.getTime();
      if (t < winLo || t > winHi) continue; // outside this department's pay week
    }
    days.push({ date, seconds: sec });
  }
  if (days.length === 0) return null;
  days.sort((a, b) => a.date.getTime() - b.date.getTime());

  const empHist = history.get(email);

  let usedRegSec = 0;
  let regularPayPHP = 0;
  let otPayPHP = 0;
  let totalSec = 0;
  let regularSec = 0;
  let otSec = 0;
  let anyRegRate = false;
  let anyOtRate = false;

  for (const d of days) {
    let reg: number | null;
    let ot: number | null;
    if (rateOverride) {
      // Payment Catalog wins over the per-day history rate.
      reg = rateOverride.reg;
      ot = rateOverride.ot;
    } else {
      const resolved = resolveRateAsOfDate(empHist, d.date);
      reg = resolved?.regularRate ?? fallbackRate?.reg ?? null;
      ot = resolved?.otRate ?? fallbackRate?.ot ?? null;
    }
    if (reg != null) anyRegRate = true;
    if (ot != null) anyOtRate = true;

    const remaining = Math.max(0, REGULAR_WEEK_CAP_SEC - usedRegSec);
    const dayRegSec = Math.min(d.seconds, remaining);
    const dayOtSec = d.seconds - dayRegSec;
    usedRegSec += dayRegSec;
    totalSec += d.seconds;
    regularSec += dayRegSec;
    otSec += dayOtSec;

    // HSL weekend premium: all hours on Saturday (6) or Sunday (0) earn +15 PHP/h
    const dow = d.date.getDay();
    const weekendBonus = isHsl && (dow === 0 || dow === 6) ? 15 : 0;

    if (reg != null) regularPayPHP += (dayRegSec / 3600) * (reg + weekendBonus);
    if (ot != null) otPayPHP += (dayOtSec / 3600) * (ot + weekendBonus);
  }

  return {
    regularPayPHP: anyRegRate ? Math.round(regularPayPHP * 100) / 100 : null,
    otPayPHP: anyOtRate ? Math.round(otPayPHP * 100) / 100 : null,
    totalSec,
    regularSec,
    otSec,
  };
}

function parseLocalIso(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function computeCurrentPay(
  opts?: { sourceFile?: string | null },
): Promise<CurrentPayResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  // When an explicit source file is requested — Payment Dispatch (or anything
  // else) operating on a PAST pay week rather than the live one — compute pay
  // for THAT upload. With no arg the path is byte-identical to before: the
  // current (`is_current`) cycle's rows + id.
  const selectedSourceFile = opts?.sourceFile?.trim() || null;
  const cycleIdPromise = selectedSourceFile
    ? supabase
      ? getHubstaffUploadIdBySourceFile(supabase, selectedSourceFile)
      : Promise.resolve(null)
    : supabase
      ? getCurrentHubstaffUploadId(supabase)
      : Promise.resolve(null);
  const hubstaffPromise = selectedSourceFile
    ? fetchHubstaffRowsBySourceFile(selectedSourceFile)
    : fetchHubstaffRowsOrdered();

  const [
    hubstaff,
    rates,
    appSettings,
    cycleId,
    masterRows,
    rateHistory,
    budgetRequestsResult,
    approvedDisputeDates,
    payStructuresResult,
    systemBonusesResult,
  ] = await Promise.all([
    hubstaffPromise,
    getEmployeeHourlyRatesRows(),
    getAppSettings([
      "usd_to_php_rate",
      USD_TO_COP_SETTINGS_KEY,
      PAB_PERIOD_OVERRIDES_KEY,
      PAB_PERIOD_EXCLUSIONS_KEY,
      US_HOLIDAYS_ENABLED_KEY,
      US_HOLIDAYS_LIST_KEY,
      HSL_WEEK_MODEL_CUTOVER_KEY,
    ]),
    cycleIdPromise,
    supabase ? fetchMasterMin(supabase) : Promise.resolve<MasterEmployeeMin[]>([]),
    fetchAllRateHistory(),
    listOrphanageBudgetRequests({ status: "approved" }),
    supabase
      ? fetchAllApprovedDisputes(supabase).then((m) => mergeApprovedTimeAdjustments(supabase, m))
      : Promise.resolve(new Map<string, Map<string, number | null>>()),
    listPayStructures(),
    listSystemBonuses(),
  ]);

  // Deferred: the full-table Hubstaff scan (every row, every upload) is ONLY
  // needed to compute PAB eligibility, which only matters on the final PAB
  // week. ~3 of every 4 loads are not the final PAB week, so fetching it here
  // unconditionally was the single biggest source of lag. We fetch it below,
  // and only when `weekIsFinalPab` turns out to be true.
  let allHubstaffRows: Record<string, unknown>[] = [];
  // TEMPORARY orphanage → PAB coverage: email -> (iso -> orphanage hours) for
  // approved orphanage-visit days. Fetched only when PAB is actually computed.
  let orphanageHoursByEmailIso: Map<string, Map<string, number>> | undefined;

  const pabOverridesValue = appSettings[PAB_PERIOD_OVERRIDES_KEY];
  const pabExclusionsValue = appSettings[PAB_PERIOD_EXCLUSIONS_KEY];
  const usHolidaysEnabledValue = appSettings[US_HOLIDAYS_ENABLED_KEY];
  const usHolidaysListValue = appSettings[US_HOLIDAYS_LIST_KEY];
  const hslWeekModelCutoverValue = appSettings[HSL_WEEK_MODEL_CUTOVER_KEY];

  // USD-anchored FX. The internal pay engine accumulates in PHP-equivalent
  // (fxRate = usdToPhp keeps that math unchanged); `fx` also carries the COP
  // rate so a COP structure resolves and a native COP payout can be derived.
  const fx: FxRates = buildFxRates(appSettings);
  const fxRate = fx.usdToPhp;

  // PAB + Tech bonus amounts + per-department allowlist are configurable in the
  // Payment Catalog (System Bonuses tab); custom `pab:*`/`tech:*` variants carry
  // a native USD/COP amount converted here via `fx`. Falls back to the legacy
  // constants + "applies to everyone" when no rows exist (pre-migration).
  const sysBonuses = resolveSystemBonuses(systemBonusesResult.bonuses, fx);

  // Index rates by both work_email and personal_email (lowercased) so a
  // hubstaff row keyed on either still resolves to a rate.
  const rateByEmail = new Map<string, { reg: number | null; ot: number | null }>();
  // MESA members: email → enrollment effective date (null = legacy member,
  // always contributing). Used to skip weeks before the member joined.
  const mesaSinceByEmail = new Map<string, string | null>();
  // email → department NAME, so the catalog's department-scoped pay structures
  // can be resolved for employees who have no per-person structure.
  const deptByEmail = new Map<string, string>();
  for (const r of rates.rows) {
    const reg = parseRateText(r.regular_rate);
    const ot = parseRateText(r.ot_rate);
    const we = normEmail(r.work_email);
    const pe = normEmail(r.personal_email);
    const entry = { reg, ot };
    if (we) rateByEmail.set(we, entry);
    if (pe && !rateByEmail.has(pe)) rateByEmail.set(pe, entry);
    if (r.department) {
      if (we && !deptByEmail.has(we)) deptByEmail.set(we, r.department);
      if (pe && !deptByEmail.has(pe)) deptByEmail.set(pe, r.department);
    }
    if (r.mesa_member === true) {
      const since = r.mesa_member_since ?? null;
      if (we) mesaSinceByEmail.set(we, since);
      if (pe) mesaSinceByEmail.set(pe, since);
    }
  }

  // Payment Catalog drives rates at compute time with priority: individual
  // (employee) structure → sheet rate → department base. This is the live
  // dispatch cycle, so the overlay applies to every day — "live cycle only"
  // historical gating lives in the dashboard estimate path
  // (member-monthly-pay.ts), not here.
  const catalogIndex = buildCatalogRateIndex(payStructuresResult.structures);

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
  // Accountant exclusions for the dispatch week's PAB month (set in the Payroll
  // Wizard → PAB settings). Excluded emails get ₱0 PAB regardless of attendance.
  let pabExcludedEmails = new Set<string>();

  // HSL week model for THIS upload — resolved from the STABLE file start date
  // (never from a week-shape-dependent value). Pre-cutover uploads stay Mon→Sun;
  // uploads on/after the effective cutover (app_settings hsl.week_model_cutover,
  // default 2026-05-31) compute Sun→Sat. Only HSL employees are affected.
  const hslWeekModel: HslWeekModel = resolveHslWeekModelWithDefault(
    periodStart,
    hslWeekModelCutoverValue,
  );

  // Per-department pay-week windows derived from the upload's start date.
  // An 8-day Sun→Sun upload yields two different 7-day weeks. Pre-cutover HSL
  // keeps Mon→Sun (drops the leading Sunday); post-cutover HSL and everyone else
  // keep Sun→Sat (drops the trailing Sunday). Per-employee hours/pay are clamped
  // to the matching window below.
  const payWeekHsl = periodStart ? payWeekFromUploadStart(periodStart, true, hslWeekModel) : null;
  const payWeekNonHsl = periodStart ? payWeekFromUploadStart(periodStart, false) : null;

  if (periodStart) {
    // PAB-month ownership + bonus timing stay MONDAY-based for ALL week models: a
    // Sun→Sat HSL week is owned by the month of the Monday inside it. Derive the
    // owning Monday from the mon_sun HSL variant (always a Monday) so switching
    // the pay window to Sun→Sat never moves a week into a different payroll cycle.
    weekMonday = payWeekFromUploadStart(periodStart, true, 'mon_sun').start;
    const pabMonth = pabMonthFromWeekStart(weekMonday);
    const monthKey = yearMonthKey(pabMonth.year, pabMonth.month);
    const overrides = parsePabPeriodOverrides(pabOverridesValue);
    const overrideEntry = overrides.get(monthKey);
    pabRange = overrideEntry
      ? { start: overrideEntry.start, end: overrideEntry.end }
      : getPabMonthRange(pabMonth.year, pabMonth.month);
    hslAdjustedEnd = getHslAdjustedEnd(pabRange.end, hslWeekModel);
    pabExcludedEmails = parsePabPeriodExclusions(pabExclusionsValue).get(monthKey) ?? new Set<string>();

    if (periodEnd) {
      // Containment gate: this upload's week must CONTAIN the PAB period end,
      // not merely end on/after it — otherwise every week after the payout
      // week re-attaches PAB (see isFinalPabWeek).
      weekIsFinalPab = gateIsFinalPabWeek(periodStart, periodEnd, pabRange.end);
    }
    weekIsTechBonus = gateIsTechBonusWeek(weekMonday);
  }

  // Now that we know whether this is the final PAB week, pull the full-table
  // Hubstaff scan only if PAB eligibility actually needs computing. On every
  // other week this stays empty and the expensive scan is skipped entirely.
  if (supabase && weekIsFinalPab) {
    const [rows, orphanageRows] = await Promise.all([
      fetchAllHubstaffRowsForBonusMonth(supabase),
      listAllOrphanagePayHours(),
    ]);
    allHubstaffRows = rows;
    // AUTO mode: orphanage hours forgive short weekdays in their coverage
    // window (file week + week before) — no dispute/excuse record needed.
    const coverage = buildOrphanageCoverageMap(
      orphanageRows.map((r) => ({ sourceFile: r.source_file, email: r.employee_email, hours: r.hours })),
    );
    if (coverage.size) orphanageHoursByEmailIso = coverage;
  }

  // 2. Build HSL email set + start_date map + master-email set from master.
  const hslEmails = new Set<string>();
  const masterEmailSet = new Set<string>();
  const startDateByEmail = new Map<string, Date>();
  // email → department NAME from the master list (identity source of truth);
  // preferred over the rates-row department for system-bonus dept eligibility.
  const masterDeptByEmail = new Map<string, string>();
  // Any of a person's emails → all of their emails (work / personal / alternates),
  // so a Hubstaff row keyed on ANY alias can resolve a Payment Catalog structure
  // keyed on a DIFFERENT alias. The Global Master List is the identity source of
  // truth for which addresses belong to one human (mirrors the wizard's
  // ratesByEmail alias bridging).
  const aliasesByEmail = new Map<string, string[]>();
  for (const m of masterRows) {
    const we = normEmail(m.work_email);
    const pe = normEmail(m.personal_email);
    const altA = normEmail(m.alternate_work_email);
    const altB = normEmail(m.alternate_work_email_2);
    for (const e of [we, pe, altA, altB]) if (e) masterEmailSet.add(e);
    const rowEmails = [we, pe, altA, altB].filter((x): x is string => !!x);
    for (const e of rowEmails) {
      const existing = aliasesByEmail.get(e);
      if (existing) {
        for (const x of rowEmails) if (!existing.includes(x)) existing.push(x);
      } else {
        aliasesByEmail.set(e, [...rowEmails]);
      }
    }
    if (m.department && m.department.trim()) {
      for (const e of [we, pe, altA, altB]) {
        if (e && !masterDeptByEmail.has(e)) masterDeptByEmail.set(e, m.department);
      }
    }
    if (m.department && m.department.trim().toLowerCase() === "hsl") {
      if (we) hslEmails.add(we);
      if (pe) hslEmails.add(pe);
    }
    const sd = parseLocalIso(m.start_date);
    if (sd) {
      if (we) startDateByEmail.set(we, sd);
      if (pe && !startDateByEmail.has(pe)) startDateByEmail.set(pe, sd);
      // Bridge alternate work emails (Global Master List is the identity source
      // of truth) so a Hubstaff/rate row keyed on an alias still resolves the
      // Tech Bonus 30-day gate. Never overwrites a primary (primary wins).
      for (const alt of [m.alternate_work_email, m.alternate_work_email_2]) {
        const a = normEmail(alt);
        if (a && !startDateByEmail.has(a)) startDateByEmail.set(a, sd);
      }
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
      orphanageHoursByEmailIso,
      weekModel: hslWeekModel,
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

    const sheetRate = rateByEmail.get(em);
    const isHslEmp = hslEmails.has(em);
    // Priority: individual (employee) catalog → sheet rate → department base.
    // PHP-equivalent (USD converted at fx). The individual catalog rate is the
    // only one that OVERRIDES the per-day history; the department rate is purely
    // a fallback for employees with no sheet rate at all.
    const empCat = resolveEmployeeCatalogRate(catalogIndex, aliasesByEmail.get(em) ?? [em], fx);
    const deptCat = resolveDeptCatalogRate(
      catalogIndex,
      deptByEmail.get(em) ?? masterDeptByEmail.get(em) ?? null,
      fx,
    );
    const catalogOverride = empCat ? { reg: empCat.regPhp, ot: empCat.otPhp } : null;
    const hasSheet = sheetRate != null && (sheetRate.reg != null || sheetRate.ot != null);
    const baseRate = hasSheet
      ? sheetRate
      : deptCat
        ? { reg: deptCat.regPhp, ot: deptCat.otPhp }
        : sheetRate;
    const reg = empCat?.regPhp ?? baseRate?.reg ?? null;
    const ot = empCat?.otPhp ?? baseRate?.ot ?? null;
    // Effective currency mirrors the rate priority above: an employee USD
    // structure wins; otherwise an existing sheet rate is PHP; otherwise the
    // department base's currency; PHP when nothing matched.
    const payCurrency: PayCurrency = empCat
      ? empCat.currency
      : hasSheet
        ? 'PHP'
        : deptCat
          ? deptCat.currency
          : 'PHP';

    // Prorate pay per day using the rate-history table — handles mid-cycle
    // promotions / department transfers where the rate flipped on a specific
    // weekday. Falls back to the legacy single-rate formula when this row
    // has no per-day ISO columns (canonical weekday CSV that couldn't be
    // resolved to dates).
    const payWindow = isHslEmp ? payWeekHsl : payWeekNonHsl;
    const sourceFileForRow =
      typeof raw['source_file'] === 'string' ? (raw['source_file'] as string) : '';
    // Resolve canonical weekday slots onto the file's TRUE ISO dates (no-op for
    // ISO rows), then let computeProratedRowPay's window clamp keep only this
    // department's 7 days. Resolving straight onto the dept pay week relabeled the
    // lone `sunday` column — which holds the file's TRAILING Sunday after the DB's
    // last-wins collapse — as the leading Sunday, so a Mon→Sun upload leaked the
    // trailing Sunday's hours into the non-HSL (Sun→Sat) week.
    const rowResolved = sourceFileForRow
      ? resolveCanonicalColumnsToIso(raw, sourceFileForRow)
      : raw;
    const prorated = computeProratedRowPay(
      rowResolved,
      rateHistory,
      em,
      baseRate,
      isHslEmp,
      payWindow,
      catalogOverride,
    );

    // Hours: when per-day ISO columns exist, report the pay-week-clamped totals
    // (so an 8-day Sun→Sun upload counts only this department's 7 days). Fall
    // back to the row aggregate when the row has no resolvable per-day columns.
    let totalHours: number;
    let otHours: number;
    let regularHours: number;
    if (prorated) {
      totalHours = Math.round((prorated.totalSec / 3600) * 100) / 100;
      otHours = Math.round((prorated.otSec / 3600) * 100) / 100;
      regularHours = Math.round((prorated.regularSec / 3600) * 100) / 100;
    } else {
      totalHours = mapped.hoursDecimal;
      otHours = mapped.overtimeDecimal;
      regularHours = Math.max(0, totalHours - otHours);
    }

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
    // 30-days check uses the Monday of the pay week for both HSL and non-HSL.
    const empHasThirtyDays =
      weekMonday && startDate ? hasThirtyDaysFromStart(weekMonday, startDate) : false;

    // Raw department string from the best source (master list wins, then the
    // rates row). Used both for bonus-eligibility keying below and surfaced on
    // the entry so Payment Dispatch can show a department for EVERY payee.
    const empDeptRaw = masterDeptByEmail.get(em) ?? deptByEmail.get(em) ?? null;
    const empDeptKey = normalizeDeptToKey(empDeptRaw);
    // Canonical label when the key resolved; otherwise keep the raw source
    // string (trimmed) so an unmapped-but-present department still shows.
    const empDeptName =
      (empDeptKey ? DEPARTMENTS.find((d) => d.key === empDeptKey)?.name : null) ??
      (empDeptRaw && empDeptRaw.trim() ? empDeptRaw.trim() : null);
    const bonus = computeEmployeeBonus({
      hasRates,
      isFinalPabWeek: weekIsFinalPab,
      // Accountant-excluded emails forfeit PAB for this month even if they passed.
      isPabEligible: pabEligible.has(em) && !pabExcludedEmails.has(em),
      isTechBonusWeek: weekIsTechBonus,
      hasThirtyDays: empHasThirtyDays,
      // Per-department amount: a custom currency variant covering this dept
      // overrides the built-in base amount (already PHP-converted).
      pabAmountPHP: systemBonusAmountForDept(sysBonuses.pab, empDeptKey),
      techAmountPHP: systemBonusAmountForDept(sysBonuses.tech, empDeptKey),
      pabDeptEligible: isDeptEligible(sysBonuses.pab, empDeptKey),
      techDeptEligible: isDeptEligible(sysBonuses.tech, empDeptKey),
    });

    // MESA: ₱100 deducted from members with a rates row, but only when this
    // cycle's week ends on/after the member's enrollment date (lexical
    // YYYY-MM-DD compare; null since = legacy member, always contributing).
    // Mirrors the Payroll Wizard dispatch gate. Accumulate into the stash
    // total so the dispatch screen can show the pool being built.
    const mesaSince = mesaSinceByEmail.has(em) ? mesaSinceByEmail.get(em) ?? null : undefined;
    const mesaEnrolledThisWeek =
      mesaSince !== undefined && (!mesaSince || !periodEndIso || mesaSince <= periodEndIso);
    const mesaDeductionPHP = hasRates && mesaEnrolledThisWeek ? 100 : 0;
    if (mesaDeductionPHP > 0) stashedMesaTotalPHP += mesaDeductionPHP;

    const totalPayPHP =
      initialPayPHP != null ? initialPayPHP + bonus.totalPHP - mesaDeductionPHP : null;
    const totalPayUSD =
      totalPayPHP != null && fxRate > 0 ? totalPayPHP / fxRate : null;
    const initialPayUSD =
      initialPayPHP != null && fxRate > 0 ? initialPayPHP / fxRate : null;
    // Native COP payout, derived from the USD anchor (not via PHP↔COP). COP has
    // no minor unit in practice — round to whole pesos. Only meaningful when the
    // employee is paid in COP; Payment Dispatch reads it for the COP tab.
    const totalPayCOP =
      totalPayUSD != null ? Math.round(totalPayUSD * fx.usdToCop) : null;

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
      totalPayCOP,
      hasRate: reg != null,
      payCurrency,
      departmentKey: empDeptKey,
      departmentName: empDeptName,
    };
  }

  // source_file is repeated on every row in the current upload — sample one.
  const sourceFile = (() => {
    for (const r of hubstaff.rows) {
      const v = r.source_file;
      if (v != null && String(v).trim() !== "") return String(v).trim();
    }
    // Fall back to the explicitly-requested file (past-week dispatch) when the
    // rows don't carry a source_file column, so `period.sourceFile` stays
    // authoritative for the selected week (drives wizardReady / staged paystubs).
    // On the live path `selectedSourceFile` is null → unchanged behavior.
    return selectedSourceFile;
  })();

  const approvedBudgetRequestsTotalPHP = (budgetRequestsResult.rows ?? []).reduce(
    (sum, r) => sum + (r.final_amount ?? 0),
    0,
  );

  return {
    period: { cycleId, start: periodStartIso, end: periodEndIso, sourceFile },
    fxRate,
    fxRates: fx,
    byEmail,
    stashedMesaTotalPHP,
    approvedBudgetRequestsTotalPHP: Math.round(approvedBudgetRequestsTotalPHP * 100) / 100,
    masterEmails: Array.from(masterEmailSet),
  };
}
