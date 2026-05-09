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
  computePabEligibleEmails,
  getHslAdjustedEnd,
  hasThirtyDaysFromStart,
  isFinalPabWeek as gateIsFinalPabWeek,
  isTechBonusWeek as gateIsTechBonusWeek,
  pabMonthFromWeekStart,
} from '@/lib/payroll/dispatch-bonuses';
import {
  columnsAreAllCanonical,
  getPabMonthRange,
  parseColDate,
  resolveCanonicalColumnsToIso,
  pabDateKey,
} from '@/lib/hubstaff/calendar-column-dedupe';
import { phpHourlyPayFromSeconds } from '@/lib/payroll/money-php';

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

const HUBSTAFF_EMAIL_KEYS = ['Email', 'email', 'Work Email', 'work_email', 'user_email'] as const;

function rowEmailNorm(row: Record<string, unknown>): string | null {
  for (const k of HUBSTAFF_EMAIL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(row, k)) {
      const v = row[k];
      if (v != null) {
        const n = normEmail(String(v));
        if (n) return n;
      }
    }
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

async function fetchAllHubstaffRows(): Promise<HubstaffRowFetchResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { rows: [], error: 'Supabase client unavailable' };
  const table =
    process.env.NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE?.trim() || 'hubstaff_hours';
  const PAGE = 1000;
  const out: Record<string, unknown>[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .range(from, from + PAGE - 1);
    if (error) return { rows: [], error: error.message };
    const page = (data ?? []) as Record<string, unknown>[];
    out.push(...page);
    if (page.length < PAGE) break;
    from += PAGE;
    if (from > 100000) break;
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
  pabBonusPHP: number;
  techBonusPHP: number;
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

/** All Hubstaff rows whose source_file's date range overlaps the supplied range. */
function rowsInRange(
  rows: Record<string, unknown>[],
  rangeStart: Date,
  rangeEnd: Date,
): Record<string, unknown>[] {
  // Conservative: include everything. The PAB eligibility check itself
  // tolerates rows outside its window — it just looks at the date columns
  // it cares about. Avoiding the per-row range parse keeps the code small.
  void rangeStart;
  void rangeEnd;
  return rows;
}

export async function computeMemberMonthlyPay(args: {
  email: string;
  year: number;
  month: number; // 0-indexed
}): Promise<{ data: MemberMonthlyPay | null; error: string | null }> {
  const emailNorm = normEmail(args.email);
  if (!emailNorm) return { data: null, error: 'Invalid email' };

  const monthStart = new Date(args.year, args.month, 1);
  const monthEnd = new Date(args.year, args.month + 1, 0);

  // Fetch everything in parallel.
  const [hsRes, rates, pabOverridesValue, masterMin] = await Promise.all([
    fetchAllHubstaffRows(),
    getEmployeeHourlyRatesRows(),
    getAppSetting(PAB_PERIOD_OVERRIDES_KEY),
    fetchMasterRowsForEmail(new Set([emailNorm])),
  ]);

  if (hsRes.error) return { data: null, error: hsRes.error };

  const masterRow = masterMin.row;
  const hslEmails = masterMin.allHsl;
  const startDate = parseLocalIso(masterRow?.start_date ?? null);

  // Build the alias set: this employee's emails (work + personal) — used for
  // matching Hubstaff rows back to them.
  const aliasNorms = new Set<string>([emailNorm]);
  const we = normEmail(masterRow?.work_email ?? null);
  const pe = normEmail(masterRow?.personal_email ?? null);
  if (we) aliasNorms.add(we);
  if (pe) aliasNorms.add(pe);

  // Find this employee's rate row (lookup by either email).
  const rateRow = (rates.rows ?? []).find((r) => {
    const rwe = normEmail(r.work_email);
    const rpe = normEmail(r.personal_email);
    return (rwe && aliasNorms.has(rwe)) || (rpe && aliasNorms.has(rpe));
  });
  const regularRate = rateRow ? parseRateText(rateRow.regular_rate) : null;
  const otRate = rateRow ? parseRateText(rateRow.ot_rate) : null;
  const hasRates = regularRate != null || otRate != null;

  // Filter Hubstaff rows down to this employee.
  const myRows = hsRes.rows.filter((r) => {
    const em = rowEmailNorm(r);
    return em != null && aliasNorms.has(em);
  });

  // Per-day seconds map covering every row (any month). We slice per-week
  // below to compute pay.
  const hoursByDateKey = buildHoursByDateKey(myRows);

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

  async function computeEligibilityForPabMonth(year: number, month: number): Promise<boolean> {
    const key = yearMonthKey(year, month);
    if (pabEligByMonthKey.has(key)) return pabEligByMonthKey.get(key)!;
    const overrideEntry = overrides.get(key);
    const pabRange = overrideEntry
      ? { start: overrideEntry.start, end: overrideEntry.end }
      : getPabMonthRange(year, month);
    const hslAdjustedEnd = getHslAdjustedEnd(pabRange.end);

    // Run computePabEligibleEmails on the merged Hubstaff data covering the
    // PAB range — but we only need rows for this employee + we need them in a
    // shape with ISO-date columns, so resolve canonical first.
    const merged: Record<string, unknown> = {};
    const candidateRows = rowsInRange(myRows, pabRange.start, hslAdjustedEnd);
    let mergedEmail: string | null = null;
    for (const row of candidateRows) {
      const em = rowEmailNorm(row);
      if (em == null || !aliasNorms.has(em)) continue;
      mergedEmail = em;
      const sourceFile =
        typeof row['source_file'] === 'string' ? (row['source_file'] as string) : '';
      const cols = Object.keys(row);
      const needsResolve = sourceFile && columnsAreAllCanonical(cols);
      const resolved = needsResolve ? resolveCanonicalColumnsToIso(row, sourceFile) : row;
      for (const [k, v] of Object.entries(resolved)) {
        if (v != null && String(v).trim() !== '') merged[k] = v;
      }
    }
    if (mergedEmail) {
      // Re-stamp the canonical Email key so computePabEligibleEmails can find it.
      merged['Email'] = mergedEmail;
    }
    const eligible = computePabEligibleEmails({
      rows: mergedEmail ? [merged] : [],
      pabRange,
      hslAdjustedEnd,
      hslEmails,
    });
    const isElig = mergedEmail != null && eligible.has(mergedEmail);
    pabEligByMonthKey.set(key, isElig);
    return isElig;
  }

  const weeks: MemberMonthlyPayWeek[] = [];
  let totalSec = 0;
  let totalRegSec = 0;
  let totalOtSec = 0;
  let totalWeekendSec = 0;
  let totalWeekendRegSec = 0;
  let totalWeekendOtSec = 0;
  let totalPabPHP = 0;
  let totalTechPHP = 0;

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
    for (const cell of dayCells) {
      if (cell.seconds <= 0) continue;
      const remaining = Math.max(0, REGULAR_WEEK_CAP_SEC - usedThisWeek);
      const dayReg = Math.min(cell.seconds, remaining);
      const dayOt = cell.seconds - dayReg;
      const isWeekend = cell.date.getDay() === 0 || cell.date.getDay() === 6;
      // Only credit toward the viewed month's totals when the day is in-month.
      if (cell.inMonth) {
        weekTotalSec += cell.seconds;
        regSec += dayReg;
        weekOtSec += dayOt;
        if (isWeekend) {
          weekWeekendTotal += cell.seconds;
          weekWeekendReg += dayReg;
          weekWeekendOt += dayOt;
        }
      }
      usedThisWeek += cell.seconds;
    }

    const regularPayPHP =
      regularRate != null ? round2(phpHourlyPayFromSeconds(regularRate, regSec)) : null;
    const otPayPHP =
      otRate != null ? round2(phpHourlyPayFromSeconds(otRate, weekOtSec)) : null;
    const weekendPayPHP =
      regularRate != null
        ? round2(
            phpHourlyPayFromSeconds(regularRate, weekWeekendReg) +
              (otRate != null ? phpHourlyPayFromSeconds(otRate, weekWeekendOt) : 0),
          )
        : null;
    const weekdayRegSec = regSec - weekWeekendReg;
    const weekdayOtSec = weekOtSec - weekWeekendOt;
    const weekdayPayPHP =
      regularRate != null
        ? round2(
            phpHourlyPayFromSeconds(regularRate, weekdayRegSec) +
              (otRate != null ? phpHourlyPayFromSeconds(otRate, weekdayOtSec) : 0),
          )
        : null;

    // Bonus gates.
    const pabMonth = pabMonthFromWeekStart(weekMon);
    const overrideEntry = overrides.get(yearMonthKey(pabMonth.year, pabMonth.month));
    const pabRange = overrideEntry
      ? { start: overrideEntry.start, end: overrideEntry.end }
      : getPabMonthRange(pabMonth.year, pabMonth.month);
    const isFinalPab = gateIsFinalPabWeek(weekSun, pabRange.end);
    const isTechWeek = gateIsTechBonusWeek(weekMon);
    const isPabElig = isFinalPab
      ? await computeEligibilityForPabMonth(pabMonth.year, pabMonth.month)
      : false;
    const has30 = startDate ? hasThirtyDaysFromStart(weekMon, startDate) : false;

    const bonus = computeEmployeeBonus({
      hasRates,
      isFinalPabWeek: isFinalPab,
      isPabEligible: isPabElig,
      isTechBonusWeek: isTechWeek,
      hasThirtyDays: has30,
    });

    const weekTotalPay =
      regularPayPHP != null && otPayPHP != null
        ? round2(regularPayPHP + otPayPHP + bonus.totalPHP)
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
      pabBonusPHP: bonus.pabBonusPHP,
      techBonusPHP: bonus.techBonusPHP,
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
  }

  const totalRegPay =
    regularRate != null ? round2(phpHourlyPayFromSeconds(regularRate, totalRegSec)) : null;
  const totalOtPay =
    otRate != null ? round2(phpHourlyPayFromSeconds(otRate, totalOtSec)) : null;
  const totalWeekendPay =
    regularRate != null
      ? round2(
          phpHourlyPayFromSeconds(regularRate, totalWeekendRegSec) +
            (otRate != null ? phpHourlyPayFromSeconds(otRate, totalWeekendOtSec) : 0),
        )
      : null;
  const totalWeekdayRegSec = totalRegSec - totalWeekendRegSec;
  const totalWeekdayOtSec = totalOtSec - totalWeekendOtSec;
  const totalWeekdayPay =
    regularRate != null
      ? round2(
          phpHourlyPayFromSeconds(regularRate, totalWeekdayRegSec) +
            (otRate != null ? phpHourlyPayFromSeconds(otRate, totalWeekdayOtSec) : 0),
        )
      : null;
  const bonusTotalPHP = totalPabPHP + totalTechPHP;
  const grandTotalPayPHP =
    totalRegPay != null && totalOtPay != null
      ? round2(totalRegPay + totalOtPay + bonusTotalPHP)
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
        grandTotalPayPHP,
      },
    },
    error: null,
  };
}

export const PAB_BONUS_PHP_EXPORT = PAB_BONUS_PHP;
export const TECH_BONUS_PHP_EXPORT = TECH_BONUS_PHP;
