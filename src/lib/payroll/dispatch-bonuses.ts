/**
 * Server-side mirror of the bonus gating logic that lives inside
 * `src/components/PayrollWizard.tsx`. Used by `current-pay.ts` so the
 * Payment Dispatch view shows the same per-employee total the wizard
 * would produce for the active week.
 *
 * Three rules captured here, all from the wizard verbatim:
 *
 *  1. **PAB ₱5,000** — fires only on the *final week* of the PAB month.
 *     Per-employee gate: `perfectAttendanceEligible` set, computed from
 *     a full-month Hubstaff merge using either the standard rule
 *     (every Mon–Fri ≥ 7h) or the HSL exception (Mon–Sun weeks, ≥ 5
 *     qualifying days, weekend reconciliation).
 *
 *  2. **Tech ₱1,850** — fires on the week whose salary date (Tuesday after
 *     the period's Sunday, i.e. period-Monday + 8 days) falls in the 3rd
 *     Mon–Sun calendar week of its month. Week 1 = the Mon–Sun week
 *     containing the 1st of the month, even if partial. Per-employee gate:
 *     30 days of service measured from `master.start_date` against the
 *     period's Monday (NOT the salary date — this matters at the boundary).
 *
 *  3. **No-rates suppression** — when an employee has neither a regular
 *     nor an OT rate, every PHP-side bonus is forced to 0. Bonuses
 *     attached to no-rate paystubs would produce misleading totals.
 *
 * Department-specific bonuses (collections tiers, lead-gen) are intentionally
 * NOT mirrored here — they depend on per-employee toggle state that lives
 * only in the wizard's browser session. The dispatch view will undercount
 * those by design until/unless the wizard persists a snapshot.
 */

import {
  buildPabCalendarWeeks,
  checkHslPabEligibility,
  groupDateColumnsByCalendarDay,
  pabDateKey,
  parseColDate,
} from "@/lib/hubstaff/calendar-column-dedupe";
import { normEmail } from "@/lib/email/norm-email";

export const PAB_BONUS_PHP = 5000;
export const TECH_BONUS_PHP = 1850;

type RawRow = Record<string, unknown>;

/**
 * Build a date → seconds map from a (possibly merged) Hubstaff row by
 * scanning every column whose name parses as a date. Picks the max value
 * across columns referring to the same calendar day.
 */
function dateSecondsFromRow(row: RawRow, allCols: string[]): Map<string, number> {
  const map = new Map<string, number>();
  const dateCols = allCols.filter((c) => parseColDate(c) !== null);
  const groups = groupDateColumnsByCalendarDay(dateCols, allCols);
  for (const group of groups) {
    let d: Date | null = null;
    for (const c of group) {
      d = parseColDate(c);
      if (d) break;
    }
    if (!d) continue;
    let maxSeconds = 0;
    for (const c of group) {
      const v = row[c];
      if (v == null) continue;
      const s = String(v).trim();
      if (!s) continue;
      const hms = /^(\d+):(\d{2}):(\d{2})$/.exec(s);
      if (hms) {
        maxSeconds = Math.max(
          maxSeconds,
          +hms[1] * 3600 + +hms[2] * 60 + +hms[3],
        );
        continue;
      }
      const dec = parseFloat(s);
      if (Number.isFinite(dec)) {
        maxSeconds = Math.max(maxSeconds, Math.round(dec * 3600));
      }
    }
    const k = pabDateKey(d);
    map.set(k, Math.max(map.get(k) ?? 0, maxSeconds));
  }
  return map;
}

/**
 * Whether a Hubstaff row's "Job type" (or "department") column reads
 * `hsl`. Used as a fallback when the master list doesn't have a
 * matching record (Hubstaff-only worker not yet on the master list).
 */
function rowSelfReportsHsl(row: RawRow): boolean {
  const raw = String(
    row['Job type'] ??
      row['job_type'] ??
      row['Job Type'] ??
      row['department'] ??
      row['Department'] ??
      '',
  )
    .trim()
    .toLowerCase();
  return raw === 'hsl' || raw === 'hogan_smith_law' || raw === 'hogan smith law';
}

/**
 * Given a set of (possibly merged across many Hubstaff uploads) rows,
 * return the set of normalized emails that pass the PAB rule for the
 * given period. HSL employees use the weekly-quota variant; everyone
 * else uses the strict every-Mon–Fri-≥-7h variant.
 */
export function computePabEligibleEmails(args: {
  rows: RawRow[];
  pabRange: { start: Date; end: Date };
  /** HSL extends the period end to the closing Sunday of the last Mon–Sun week. */
  hslAdjustedEnd: Date;
  /** Lowercased emails for HSL employees, derived from master list. */
  hslEmails: Set<string>;
}): Set<string> {
  const { rows, pabRange, hslAdjustedEnd, hslEmails } = args;
  const eligible = new Set<string>();
  if (rows.length === 0) return eligible;

  const sampleCols = Object.keys(rows[0]);

  for (const row of rows) {
    const rawEmail = String(row['Email'] ?? row['email'] ?? '').trim();
    const email = normEmail(rawEmail) ?? rawEmail.toLowerCase();
    if (!email) continue;

    const cols = Object.keys(row).length > 0 ? Object.keys(row) : sampleCols;
    const hoursByDateKey = dateSecondsFromRow(row, cols);

    const isHsl = hslEmails.has(email) || rowSelfReportsHsl(row);

    let passes: boolean;
    if (isHsl) {
      passes = checkHslPabEligibility(pabRange.start, hslAdjustedEnd, hoursByDateKey);
    } else {
      const weeks = buildPabCalendarWeeks(pabRange.start, pabRange.end, hoursByDateKey);
      const flat = weeks.flat();
      passes = flat.length > 0 && flat.every((d) => d.passes);
    }

    if (passes) eligible.add(email);
  }
  return eligible;
}

/**
 * For HSL the period extends to the Sunday that closes the last Mon–Sun
 * week so a full week is evaluated. Returns the original end if it's
 * already a Sunday.
 */
export function getHslAdjustedEnd(pabEnd: Date): Date {
  const d = new Date(pabEnd.getFullYear(), pabEnd.getMonth(), pabEnd.getDate());
  const dow = d.getDay(); // Sun=0 … Sat=6
  if (dow !== 0) d.setDate(d.getDate() + (7 - dow));
  return d;
}

/**
 * The current pay period's Monday from a Hubstaff date column.
 * Hubstaff CSVs run Sunday→Saturday; the "week" the wizard treats as a
 * pay period starts on the Monday inside that range.
 */
export function pabMonthFromWeekStart(weekStart: Date): { year: number; month: number } {
  const dow = weekStart.getDay();
  const daysBackToMon = dow === 0 ? 6 : dow - 1;
  const mon = new Date(
    weekStart.getFullYear(),
    weekStart.getMonth(),
    weekStart.getDate() - daysBackToMon,
  );
  return { year: mon.getFullYear(), month: mon.getMonth() };
}

/**
 * `true` when the dispatch week's last day is on or after the PAB period's
 * end — i.e. this is the paycheck that closes the month and should carry
 * the PAB bonus.
 */
export function isFinalPabWeek(weekEnd: Date, pabPeriodEnd: Date): boolean {
  const endMid = new Date(
    pabPeriodEnd.getFullYear(),
    pabPeriodEnd.getMonth(),
    pabPeriodEnd.getDate(),
  ).getTime();
  return weekEnd.getTime() >= endMid;
}

/**
 * Wizard rule: salary date = period Monday + 8 days. Tech bonus fires
 * when that salary date lands inside the 3rd Mon–Sun calendar week of its
 * month. Strict equality: only the 3rd week, not 4th+.
 */
export function isTechBonusWeek(weekMonday: Date): boolean {
  const salary = new Date(
    weekMonday.getFullYear(),
    weekMonday.getMonth(),
    weekMonday.getDate() + 8,
  );
  const first = new Date(salary.getFullYear(), salary.getMonth(), 1);
  const dow = first.getDay();
  const daysBack = dow === 0 ? 6 : dow - 1;
  const firstMon = new Date(
    first.getFullYear(),
    first.getMonth(),
    first.getDate() - daysBack,
  );
  const thirdMon = new Date(
    firstMon.getFullYear(),
    firstMon.getMonth(),
    firstMon.getDate() + 14,
  );
  const fourthMon = new Date(
    firstMon.getFullYear(),
    firstMon.getMonth(),
    firstMon.getDate() + 21,
  );
  const t = salary.getTime();
  return t >= thirdMon.getTime() && t < fourthMon.getTime();
}

/**
 * Wizard rule: 30-day service is checked against the *period's Monday*,
 * not the salary date. eligibleFrom = startDate + 30d, then the period
 * Monday must be on or after that date.
 */
export function hasThirtyDaysFromStart(weekMonday: Date, startDate: Date): boolean {
  const eligibleFrom = new Date(
    startDate.getFullYear(),
    startDate.getMonth(),
    startDate.getDate() + 30,
  );
  return weekMonday.getTime() >= eligibleFrom.getTime();
}

export interface BonusBreakdown {
  pabBonusPHP: number;
  techBonusPHP: number;
  totalPHP: number;
}

/**
 * Combined per-employee gate. Returns the actual peso amount that
 * should be added on top of the regular + OT pay for this dispatch.
 */
export function computeEmployeeBonus(args: {
  hasRates: boolean;
  isFinalPabWeek: boolean;
  isPabEligible: boolean;
  isTechBonusWeek: boolean;
  hasThirtyDays: boolean;
}): BonusBreakdown {
  const { hasRates } = args;
  if (!hasRates) {
    return { pabBonusPHP: 0, techBonusPHP: 0, totalPHP: 0 };
  }
  const pabBonusPHP = args.isFinalPabWeek && args.isPabEligible ? PAB_BONUS_PHP : 0;
  const techBonusPHP = args.isTechBonusWeek && args.hasThirtyDays ? TECH_BONUS_PHP : 0;
  return { pabBonusPHP, techBonusPHP, totalPHP: pabBonusPHP + techBonusPHP };
}
