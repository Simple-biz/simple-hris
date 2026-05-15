/**
 * Per-employee, per-month pay calculator that mirrors the wizard's bonus
 * gates so the manager dashboard's member modal can show the same numbers
 * Lenny would dispatch.
 *
 * Mirrors `current-pay.ts` for bonuses but operates on a requested calendar
 * month rather than the latest Hubstaff cycle. Iterates each Mon-Sun pay
 * week that overlaps the viewed month and runs:
 *   - regular vs overtime split (40h/week cap, weekend portion tracked)
 *   - PAB ₱5,000 if final-week-of-PAB-month + employee passed eligibility
 *   - Tech ₱1,850 if 3rd-week salary date + ≥30 days of service
 */
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from '@/lib/supabase/server';
import { getEmployeeHourlyRatesRows } from '@/lib/supabase/employee-hourly-rates';
import { getAppSetting } from '@/lib/supabase/app-settings';
import { normEmail } from '@/lib/email/norm-email';
import {
  PAB_PERIOD_OVERRIDES_KEY,
  parsePabPeriodOverrides,
  yearMonthKey,
} from '@/lib/pab-period-settings';
import {
  PAB_BONUS_PHP,
  TECH_BONUS_PHP,
  computeEmployeeBonus,
  getHslAdjustedEnd,
  hasThirtyDaysFromStart,
  isFinalPabWeek as gateIsFinalPabWeek,
  isTechBonusWeek as gateIsTechBonusWeek,
  pabMonthFromWeekStart,
} from '@/lib/payroll/dispatch-bonuses';
import {
  buildPabCalendarWeeks,
  checkHslPabEligibility,
  columnsAreAllCanonical,
  getPabMonthRange,
  parseColDate,
  resolveCanonicalColumnsToIso,
  pabDateKey,
} from '@/lib/hubstaff/calendar-column-dedupe';
import { phpHourlyPayFromSeconds } from '@/lib/payroll/money-php';
import { fetchAllRateHistory, resolveRateAsOfDate } from '@/lib/payroll/rate-history';

const NON_DATE_COLS = new Set([
  'id',
  'email',
  'member',
  'total worked',
  'activity',
  'organization',
  'time zone',
  'job type',
  'job title',
  'work email',
  'personal email',
  'employee id',
  'tax info',
  'location',
  'date added',
  'spent total',
  'currency',
  'source_file',
  'upload_id',
  'created_at',
]);

const CANONICAL_WEEKDAYS = new Set([
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]);

function isDateCol(col: string): boolean {
  const lower = col.trim().toLowerCase();
  if (NON_DATE_COLS.has(lower)) return false;
  if (CANONICAL_WEEKDAYS.has(lower)) return true;
  if (/^(mon|tue|wed|thu|fri|sat|sun)/i.test(col.trim())) return true;
  return /^\d{4}-\d{2}-\d{2}$/.test(col.trim());
}

function parseHMS(v: unknown): number {
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

function parseRateText(v: string | null | undefined): number | null {
  if (v == null) return null;
  const s = String(v).trim().replace(/,/g, '');
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parses a `Start Date` value from the master list. Handles three formats
 * because the column is plain text and historical CSVs were not consistent:
 *   - `YYYY-MM-DD` (ISO; what the SQL editor and newer imports produce)
 *   - `MM/DD/YY`   (Google Sheet default; matches the auto-memory note)
 *   - `MM/DD/YYYY` (older exports)
 *
 * Constructed via `new Date(year, month, day)` so the result is local-midnight,
 * which matters for the 30-day comparison against `weekMonday` (also local).
 */
function parseLocalIso(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // YYYY-MM-DD (optionally with trailing time component)
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (iso) {
    const d = new Date(+iso[1], +iso[2] - 1, +iso[3]);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // MM/DD/YY or MM/DD/YYYY (with single- or double-digit M/D)
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (slash) {
    const month = +slash[1] - 1;
    const day = +slash[2];
    let year = +slash[3];
    // 2-digit years: 00-69 → 2000s, 70-99 → 1900s. Same convention the rest
    // of the app uses for historical Hubstaff filenames.
    if (slash[3].length === 2) year = year < 70 ? 2000 + year : 1900 + year;
    const d = new Date(year, month, day);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // Last-resort fallback — let JS try. Anchored to local midnight to dodge tz drift.
  const fallback = new Date(s);
  if (!Number.isNaN(fallback.getTime())) {
    return new Date(fallback.getFullYear(), fallback.getMonth(), fallback.getDate());
  }
  return null;
}

function mondayOfWeekContaining(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = x.getDay();
  const daysBack = dow === 0 ? 6 : dow - 1;
  x.setDate(x.getDate() - daysBack);
  return x;
}

interface HubstaffRowFetchResult {
  rows: Record<string, unknown>[];
  error: string | null;
}

/**
 * Fetches only the rows belonging to this employee from hubstaff_hours, filtering
 * at the DB level. The Email column uses a capital E per the Hubstaff CSV upload
 * mapping (see HUBSTAFF_LEADING_COLS in hubstaff-hours-db.ts). Replaces the old
 * full-table paginated scan that fetched every employee's rows just to filter client-side.
 */
async function fetchHubstaffRowsForEmail(
  emailNorms: Set<string>,
): Promise<HubstaffRowFetchResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { rows: [], error: 'Supabase client unavailable' };
  const table =
    process.env.NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE?.trim() || 'hubstaff_hours';

  const emails = [...emailNorms].filter(Boolean);
  if (emails.length === 0) return { rows: [], error: null };

  // PostgREST OR filter on the "Email" column (capital E, per Hubstaff CSV mapping).
  // e.g. "Email".eq.user@example.com,"Email".eq.alias@example.com
  const orFilter = emails.map((e) => `"Email".eq.${e}`).join(',');

  const PAGE = 1000;
  const out: Record<string, unknown>[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .or(orFilter)
      .range(from, from + PAGE - 1);
    if (error) return { rows: [], error: error.message };
    const page = (data ?? []) as Record<string, unknown>[];
    out.push(...page);
    if (page.length < PAGE) break;
    from += PAGE;
    if (from > 10_000) break; // one employee won't have >10k rows
  }
  return { rows: out, error: null };
}

interface MasterMin {
  work_email: string | null;
  personal_email: string | null;
  start_date: string | null;
  department: string | null;
}

async function fetchMasterRowsForEmail(
  emailNorms: Set<string>,
): Promise<{ row: MasterMin | null; allHsl: Set<string> }> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  const allHsl = new Set<string>();
  if (!supabase) return { row: null, allHsl };
  const { data } = await supabase
    .from('active_employees')
    .select('"Work Email", "Personal Email", "Start Date", "Department"');
  if (!data) return { row: null, allHsl };
  let myRow: MasterMin | null = null;
  for (const raw of data as Array<Record<string, unknown>>) {
    const m: MasterMin = {
      work_email: typeof raw['Work Email'] === 'string' ? (raw['Work Email'] as string) : null,
      personal_email:
        typeof raw['Personal Email'] === 'string' ? (raw['Personal Email'] as string) : null,
      start_date: typeof raw['Start Date'] === 'string' ? (raw['Start Date'] as string) : null,
      department:
        typeof raw['Department'] === 'string' ? (raw['Department'] as string) : null,
    };
    const we = normEmail(m.work_email);
    const pe = normEmail(m.personal_email);
    if (m.department && m.department.trim().toLowerCase() === 'hsl') {
      if (we) allHsl.add(we);
      if (pe) allHsl.add(pe);
    }
    if (!myRow && ((we && emailNorms.has(we)) || (pe && emailNorms.has(pe)))) {
      myRow = m;
    }
  }
  return { row: myRow, allHsl };
}

export interface MemberMonthlyPayWeek {
  /** ISO date of the Monday anchoring this pay week. */
  weekStart: string;
  /** ISO date of the Sunday closing this pay week. */
  weekEnd: string;
  /** Whether any day of this week falls in the viewed month. */
  inMonth: boolean;
  totalSec: number;
  regularSec: number;
  otSec: number;
  weekendTotalSec: number;
  weekendRegularSec: number;
  weekendOtSec: number;
  regularPayPHP: number | null;
  otPayPHP: number | null;
  weekendPayPHP: number | null;
  weekdayPayPHP: number | null;
  isFinalPabWeek: boolean;
  isTechBonusWeek: boolean;
  isPabEligible: boolean;
  hasThirtyDays: boolean;
  /** False when today is still inside the PAB period — month not yet complete. */
  pabMonthComplete: boolean;
  /** False when today is before this week's salary date (period Monday + 8 days). */
  techSalaryReached: boolean;
  pabBonusPHP: number;
  techBonusPHP: number;
  /** ₱100 MESA contribution deducted from this week's paycheck when the employee
   *  is a MESA member and worked any in-month hours. 0 otherwise. */
  mesaDeductionPHP: number;
  weekTotalPayPHP: number | null;
}

export interface MemberMonthlyPay {
  email: string;
  year: number;
  month: number;
  hasRate: boolean;
  regularRate: number | null;
  otRate: number | null;
  startDate: string | null;
  department: string | null;
  weeks: MemberMonthlyPayWeek[];
  totals: {
    totalSec: number;
    regularSec: number;
    otSec: number;
    weekendSec: number;
    weekendRegularSec: number;
    weekendOtSec: number;
    regularPayPHP: number | null;
    otPayPHP: number | null;
    weekendPayPHP: number | null;
    weekdayPayPHP: number | null;
    pabBonusPHP: number;
    techBonusPHP: number;
    bonusTotalPHP: number;
    /** Sum of every week's ₱100 MESA deduction. 0 when the employee isn't a member. */
    mesaDeductionPHP: number;
    /** True iff the employee is currently a MESA program member. */
    mesaMember: boolean;
    grandTotalPayPHP: number | null;
  };
}

function fmtIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const REGULAR_WEEK_CAP_SEC = 40 * 3600;

/**
 * Build a per-day seconds map from this employee's Hubstaff rows. Each row
 * may either carry ISO date columns directly or canonical weekday columns
 * resolvable via the source_file.
 */
function buildHoursByDateKey(
  rows: Record<string, unknown>[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const sourceFile = typeof row['source_file'] === 'string' ? (row['source_file'] as string) : '';
    const cols = Object.keys(row);
    const needsResolve = sourceFile && columnsAreAllCanonical(cols);
    const resolved = needsResolve ? resolveCanonicalColumnsToIso(row, sourceFile) : row;
    for (const [k, v] of Object.entries(resolved)) {
      if (!isDateCol(k)) continue;
      const d = parseColDate(k);
      if (!d) continue;
      const sec = parseHMS(v);
      if (sec <= 0) continue;
      const key = pabDateKey(d);
      map.set(key, Math.max(map.get(key) ?? 0, sec));
    }
  }
  return map;
}

export async function computeMemberMonthlyPay(args: {
  email: string;
  year: number;
  month: number; // 0-indexed
}): Promise<{ data: MemberMonthlyPay | null; error: string | null }> {
  const emailNormMaybe = normEmail(args.email);
  if (!emailNormMaybe) return { data: null, error: 'Invalid email' };
  const emailNorm: string = emailNormMaybe;

  const monthStart = new Date(args.year, args.month, 1);
  const monthEnd = new Date(args.year, args.month + 1, 0);

  // Step 1: Fetch master + rates + PAB overrides in parallel. We need the master
  // row first to know this employee's alias emails before querying Hubstaff.
  const [masterMin, rates, pabOverridesValue, rateHistory] = await Promise.all([
    fetchMasterRowsForEmail(new Set([emailNorm])),
    getEmployeeHourlyRatesRows(),
    getAppSetting(PAB_PERIOD_OVERRIDES_KEY),
    fetchAllRateHistory(),
  ]);

  const masterRow = masterMin.row;
  const hslEmails = masterMin.allHsl;
  const startDate = parseLocalIso(masterRow?.start_date ?? null);

  // Build the alias set: this employee's emails (work + personal).
  const aliasNorms = new Set<string>([emailNorm]);
  const we = normEmail(masterRow?.work_email ?? null);
  const pe = normEmail(masterRow?.personal_email ?? null);
  if (we) aliasNorms.add(we);
  if (pe) aliasNorms.add(pe);

  // Step 2: Fetch only this employee's Hubstaff rows (server-side filtered by email).
  const hsRes = await fetchHubstaffRowsForEmail(aliasNorms);
  if (hsRes.error) return { data: null, error: hsRes.error };

  // Find this employee's rate row (lookup by either email).
  const rateRow = (rates.rows ?? []).find((r) => {
    const rwe = normEmail(r.work_email);
    const rpe = normEmail(r.personal_email);
    return (rwe && aliasNorms.has(rwe)) || (rpe && aliasNorms.has(rpe));
  });
  const regularRate = rateRow ? parseRateText(rateRow.regular_rate) : null;
  const otRate = rateRow ? parseRateText(rateRow.ot_rate) : null;
  const hasRates = regularRate != null || otRate != null;
  const mesaMember = rateRow?.mesa_member === true;
  // Per-week MESA contribution. When the `mesa_start_date` column lands on
  // `employee_hourly_rates`, gate this by `week_start >= mesa_start_date` —
  // for now every MESA member with rates contributes ₱100 every active week.
  const MESA_DEDUCTION_PHP = 100;
  // Per-email rate-history list (sorted desc by effective_from), used by the
  // per-day prorating loop. May be undefined when no history exists yet.
  const empHist = rateHistory.get(emailNorm)
    ?? (we ? rateHistory.get(we) : undefined)
    ?? (pe ? rateHistory.get(pe) : undefined);

  // Per-day seconds map covering every row (any month). We slice per-week
  // below to compute pay.
  const hoursByDateKey = buildHoursByDateKey(hsRes.rows);

  // ── Enumerate pay weeks (Mon-Sun) overlapping the viewed month.
  const firstWeekMon = mondayOfWeekContaining(monthStart);
  const lastWeekMon = mondayOfWeekContaining(monthEnd);
  const weekMondays: Date[] = [];
  for (
    let cur = new Date(firstWeekMon);
    cur.getTime() <= lastWeekMon.getTime();
    cur.setDate(cur.getDate() + 7)
  ) {
    weekMondays.push(new Date(cur));
  }

  // For PAB eligibility checks: any week is `isFinalPabWeek` based on its
  // weekEnd vs the PAB month's adjusted end. We pre-compute eligibility for
  // every PAB month touched by these weeks once (eligibility is per-employee
  // per-PAB-month, not per-week).
  const overrides = parsePabPeriodOverrides(pabOverridesValue);
  const pabEligByMonthKey = new Map<string, boolean>();

  function computeEligibilityForPabMonth(year: number, month: number): boolean {
    const key = yearMonthKey(year, month);
    if (pabEligByMonthKey.has(key)) return pabEligByMonthKey.get(key)!;
    const overrideEntry = overrides.get(key);
    const pabRange = overrideEntry
      ? { start: overrideEntry.start, end: overrideEntry.end }
      : getPabMonthRange(year, month);
    const hslAdjustedEnd = getHslAdjustedEnd(pabRange.end);

    // Use the same hoursByDateKey that powers the calendar (max-per-day across
    // all uploads). This guarantees the PAB check is consistent with what the
    // manager can see — a red day on the calendar always fails PAB here too.
    const isHsl = hslEmails.has(emailNorm);
    let passes: boolean;
    if (isHsl) {
      passes = checkHslPabEligibility(pabRange.start, hslAdjustedEnd, hoursByDateKey);
    } else {
      const weeks = buildPabCalendarWeeks(pabRange.start, pabRange.end, hoursByDateKey);
      const flat = weeks.flat();
      passes = flat.length > 0 && flat.every((d) => d.passes);
    }
    pabEligByMonthKey.set(key, passes);
    return passes;
  }

  const todayRaw = new Date();
  const todayMid = new Date(todayRaw.getFullYear(), todayRaw.getMonth(), todayRaw.getDate());

  const weeks: MemberMonthlyPayWeek[] = [];
  let totalSec = 0;
  let totalRegSec = 0;
  let totalOtSec = 0;
  let totalWeekendSec = 0;
  let totalWeekendRegSec = 0;
  let totalWeekendOtSec = 0;
  let totalPabPHP = 0;
  let totalTechPHP = 0;
  let totalMesaPHP = 0;

  for (const weekMon of weekMondays) {
    const weekSun = new Date(weekMon);
    weekSun.setDate(weekSun.getDate() + 6);

    // Only count seconds from days that fall in the viewed month — this is
    // what makes the month roll-up answer "what did we pay for work in this
    // month?" rather than "what did this paycheck total?". The 40h cap is
    // applied to the FULL week (Mon-Sun) of seconds, however, so OT
    // attribution stays correct when a week straddles months.
    const dayCells: { date: Date; seconds: number; inMonth: boolean }[] = [];
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(weekMon);
      d.setDate(d.getDate() + i);
      const sec = hoursByDateKey.get(pabDateKey(d)) ?? 0;
      const inMonth = d.getMonth() === args.month && d.getFullYear() === args.year;
      dayCells.push({ date: d, seconds: sec, inMonth });
    }

    let weekTotalSec = 0;
    let regSec = 0;
    let weekOtSec = 0;
    let weekWeekendTotal = 0;
    let weekWeekendReg = 0;
    let weekWeekendOt = 0;
    let usedThisWeek = 0;
    // Per-day prorating accumulators. When `empHist` covers this employee,
    // each day's hours are paid at the rate effective on that calendar date —
    // mirrors `current-pay.ts → computeProratedRowPay`. Without history (or
    // for days with no resolution) we fall back to the employee's current
    // regularRate/otRate cache.
    let proratedRegPay = 0;
    let proratedOtPay = 0;
    let proratedWeekendPay = 0;
    let anyRegRateThisWeek = false;
    let anyOtRateThisWeek = false;
    // Only process in-month days — adjacent-month days in straddling weeks must NOT
    // consume the 40h regular cap for this month (matches My Hours behaviour).
    for (const cell of dayCells) {
      if (!cell.inMonth || cell.seconds <= 0) continue;
      const remaining = Math.max(0, REGULAR_WEEK_CAP_SEC - usedThisWeek);
      const dayReg = Math.min(cell.seconds, remaining);
      const dayOt = cell.seconds - dayReg;
      const isWeekend = cell.date.getDay() === 0 || cell.date.getDay() === 6;
      weekTotalSec += cell.seconds;
      regSec += dayReg;
      weekOtSec += dayOt;
      usedThisWeek += cell.seconds;
      if (isWeekend) {
        weekWeekendTotal += cell.seconds;
        weekWeekendReg += dayReg;
        weekWeekendOt += dayOt;
      }

      const resolved = resolveRateAsOfDate(empHist, cell.date);
      const dayReg$ = resolved?.regularRate ?? regularRate;
      const dayOt$  = resolved?.otRate      ?? otRate;
      if (dayReg$ != null) {
        anyRegRateThisWeek = true;
        const pay = phpHourlyPayFromSeconds(dayReg$, dayReg);
        proratedRegPay += pay;
        if (isWeekend) proratedWeekendPay += pay;
      }
      if (dayOt$ != null) {
        anyOtRateThisWeek = true;
        const pay = phpHourlyPayFromSeconds(dayOt$, dayOt);
        proratedOtPay += pay;
        if (isWeekend) proratedWeekendPay += pay;
      }
    }

    const regularPayPHP = anyRegRateThisWeek ? round2(proratedRegPay) : null;
    const otPayPHP      = anyOtRateThisWeek  ? round2(proratedOtPay)  : null;
    const weekendPayPHP = anyRegRateThisWeek ? round2(proratedWeekendPay) : null;
    const weekdayPayPHP =
      regularPayPHP != null && otPayPHP != null && weekendPayPHP != null
        ? round2(regularPayPHP + otPayPHP - weekendPayPHP)
        : regularPayPHP != null && weekendPayPHP != null
          ? round2(regularPayPHP - weekendPayPHP)
          : null;

    // Bonus gates.
    const pabMonth = pabMonthFromWeekStart(weekMon);
    // Only count PAB for weeks that belong to the viewed month's PAB period.
    // A straddling week like March 30–April 5 belongs to March's PAB (its Monday
    // is in March) and must not fire March's bonus inside the April view.
    const pabBelongsToViewedMonth =
      pabMonth.year === args.year && pabMonth.month === args.month;
    const overrideEntry = overrides.get(yearMonthKey(pabMonth.year, pabMonth.month));
    const pabRange = overrideEntry
      ? { start: overrideEntry.start, end: overrideEntry.end }
      : getPabMonthRange(pabMonth.year, pabMonth.month);
    // PAB only counts after the period has fully closed (today is strictly after end day).
    const pabEndMid = new Date(
      pabRange.end.getFullYear(),
      pabRange.end.getMonth(),
      pabRange.end.getDate(),
    );
    const pabMonthComplete = todayMid.getTime() > pabEndMid.getTime();
    const isFinalPab = pabBelongsToViewedMonth && gateIsFinalPabWeek(weekSun, pabRange.end);
    const isTechWeek = gateIsTechBonusWeek(weekMon);
    // Tech bonus only counts once the salary date (period Monday + 8 days) has arrived.
    const salaryDate = new Date(weekMon.getFullYear(), weekMon.getMonth(), weekMon.getDate() + 8);
    const techSalaryReached = todayMid.getTime() >= salaryDate.getTime();
    const isPabElig = isFinalPab && pabMonthComplete
      ? computeEligibilityForPabMonth(pabMonth.year, pabMonth.month)
      : false;
    const has30 = startDate ? hasThirtyDaysFromStart(weekMon, startDate) : false;

    const bonus = computeEmployeeBonus({
      hasRates,
      isFinalPabWeek: isFinalPab && pabMonthComplete,
      isPabEligible: isPabElig,
      isTechBonusWeek: isTechWeek && techSalaryReached,
      hasThirtyDays: has30,
    });

    // MESA deduction: ₱100 per week, applied only to weeks where the
    // employee has rates AND actually worked some in-month hours. Future
    // refinement (TODO): gate by an `employee_hourly_rates.mesa_start_date`
    // column so contributions don't accrue for weeks before the employee
    // joined the program.
    const mesaDeductionPHP =
      mesaMember && hasRates && weekTotalSec > 0 ? MESA_DEDUCTION_PHP : 0;

    const weekTotalPay =
      regularPayPHP != null && otPayPHP != null
        ? round2(regularPayPHP + otPayPHP + bonus.totalPHP - mesaDeductionPHP)
        : null;

    const inMonth = dayCells.some((c) => c.inMonth);
    weeks.push({
      weekStart: fmtIso(weekMon),
      weekEnd: fmtIso(weekSun),
      inMonth,
      totalSec: weekTotalSec,
      regularSec: regSec,
      otSec: weekOtSec,
      weekendTotalSec: weekWeekendTotal,
      weekendRegularSec: weekWeekendReg,
      weekendOtSec: weekWeekendOt,
      regularPayPHP,
      otPayPHP,
      weekendPayPHP,
      weekdayPayPHP,
      isFinalPabWeek: isFinalPab,
      isTechBonusWeek: isTechWeek,
      isPabEligible: isPabElig,
      hasThirtyDays: has30,
      pabMonthComplete,
      techSalaryReached,
      pabBonusPHP: bonus.pabBonusPHP,
      techBonusPHP: bonus.techBonusPHP,
      mesaDeductionPHP,
      weekTotalPayPHP: weekTotalPay,
    });

    totalSec += weekTotalSec;
    totalRegSec += regSec;
    totalOtSec += weekOtSec;
    totalWeekendSec += weekWeekendTotal;
    totalWeekendRegSec += weekWeekendReg;
    totalWeekendOtSec += weekWeekendOt;
    totalPabPHP += bonus.pabBonusPHP;
    totalTechPHP += bonus.techBonusPHP;
    totalMesaPHP += mesaDeductionPHP;
  }

  // Sum totals from the per-week values so prorating carries through.
  const sumNullable = (vals: Array<number | null>): number | null => {
    let any = false;
    let s = 0;
    for (const v of vals) {
      if (v != null) {
        any = true;
        s += v;
      }
    }
    return any ? round2(s) : null;
  };
  const totalRegPay = sumNullable(weeks.map((w) => w.regularPayPHP));
  const totalOtPay  = sumNullable(weeks.map((w) => w.otPayPHP));
  const totalWeekendPay = sumNullable(weeks.map((w) => w.weekendPayPHP));
  const totalWeekdayPay = sumNullable(weeks.map((w) => w.weekdayPayPHP));
  const bonusTotalPHP = totalPabPHP + totalTechPHP;
  const grandTotalPayPHP =
    totalRegPay != null && totalOtPay != null
      ? round2(totalRegPay + totalOtPay + bonusTotalPHP - totalMesaPHP)
      : null;

  return {
    data: {
      email: emailNorm,
      year: args.year,
      month: args.month,
      hasRate: hasRates,
      regularRate,
      otRate,
      startDate: masterRow?.start_date ?? null,
      department: masterRow?.department ?? null,
      weeks,
      totals: {
        totalSec,
        regularSec: totalRegSec,
        otSec: totalOtSec,
        weekendSec: totalWeekendSec,
        weekendRegularSec: totalWeekendRegSec,
        weekendOtSec: totalWeekendOtSec,
        regularPayPHP: totalRegPay,
        otPayPHP: totalOtPay,
        weekendPayPHP: totalWeekendPay,
        weekdayPayPHP: totalWeekdayPay,
        pabBonusPHP: totalPabPHP,
        techBonusPHP: totalTechPHP,
        bonusTotalPHP,
        mesaDeductionPHP: totalMesaPHP,
        mesaMember,
        grandTotalPayPHP,
      },
    },
    error: null,
  };
}

export const PAB_BONUS_PHP_EXPORT = PAB_BONUS_PHP;
export const TECH_BONUS_PHP_EXPORT = TECH_BONUS_PHP;
