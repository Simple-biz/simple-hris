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
 *     (every Mon–Fri ≥ 7h) or the HSL exception:
 *       • Mon–Sun weeks, ≥ 5 of 7 days at ≥ 7 h.
 *       • Sat and Sun count independently toward the quota.
 *       • Overnight shifts split across midnight combine via forward
 *         (D + D₊₁ ≥ 7h) AND backward (D₋₁ + D ≥ 7h) checks —
 *         both days in a qualifying pair earn a passing-day credit.
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
 * Applies approved dispute overrides and US-holiday auto-passes to a
 * per-date seconds map before the PAB eligibility check runs.
 *
 * Dispute SET semantics (mirrors PayrollWizard.tsx):
 *   override_hours != null  ->  effective = override_hours * 3600
 *   override_hours == null  ->  effective = raw Hubstaff seconds
 *   If effective < 7 h AND a dispute exists AND effective >= 4 h -> forgiven (pass)
 *
 * US holidays set the day to 7 h so the >= 7 h gate auto-passes without
 * requiring Hubstaff data (same as the wizard's `continue` on holiday dates).
 * Holidays are applied last so they are never overridden by a dispute entry.
 */
function applyPabAdjustments(
  hoursByDateKey: Map<string, number>,
  forgivenDates: Map<string, number | null> | undefined,
  usHolidayDates: Set<string> | undefined,
): Map<string, number> {
  if (!forgivenDates?.size && !usHolidayDates?.size) return hoursByDateKey;
  const effective = new Map(hoursByDateKey);

  if (forgivenDates) {
    for (const [dateStr, overrideHours] of forgivenDates.entries()) {
      const parts = dateStr.split('-');
      if (parts.length !== 3) continue;
      const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      if (Number.isNaN(d.getTime())) continue;
      const key = pabDateKey(d);
      const rawSec = hoursByDateKey.get(key) ?? 0;
      const effectiveSec = overrideHours != null ? overrideHours * 3600 : rawSec;
      // Forgiven when dispute exists and effective hours >= 4 h
      effective.set(key, effectiveSec >= 4 * 3600 ? 7 * 3600 : effectiveSec);
    }
  }

  if (usHolidayDates) {
    for (const dateStr of usHolidayDates) {
      const parts = dateStr.split('-');
      if (parts.length !== 3) continue;
      const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      if (Number.isNaN(d.getTime())) continue;
      effective.set(pabDateKey(d), 7 * 3600);
    }
  }

  return effective;
}

/**
 * Given a set of (possibly merged across many Hubstaff uploads) rows,
 * return the set of normalized emails that pass the PAB rule for the
 * given period. HSL employees use the weekly-quota variant; everyone
 * else uses the strict every-Mon-Fri->=7h variant.
 *
 * Approved dispute overrides and US holiday forgiveness are applied to
 * the per-day hours before the eligibility check, mirroring the wizard.
 */
export function computePabEligibleEmails(args: {
  rows: RawRow[];
  pabRange: { start: Date; end: Date };
  /** HSL extends the period end to the closing Sunday of the last Mon-Sun week. */
  hslAdjustedEnd: Date;
  /** Lowercased emails for HSL employees, derived from master list. */
  hslEmails: Set<string>;
  /**
   * Approved PAB disputes for the period, keyed by lowercased work email then
   * by ISO dispute_date. Value is override_hours (null = no explicit override;
   * effective hours fall back to the raw Hubstaff value for that day).
   */
  approvedDisputeDates?: Map<string, Map<string, number | null>>;
  /**
   * ISO date strings for enabled US holidays in the PAB period.
   * Matching days auto-pass the >= 7 h gate regardless of Hubstaff hours.
   */
  usHolidayDates?: Set<string>;
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
    const rawHours = dateSecondsFromRow(row, cols);

    const forgivenDates = args.approvedDisputeDates?.get(email);
    const hoursByDateKey = applyPabAdjustments(rawHours, forgivenDates, args.usHolidayDates);

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
 * Carla's rule (May 2026 meeting): salary date = period Monday + 8 days.
 * Tech bonus fires when that salary date lands inside the **3rd full Mon–Sun
 * week** of its month — "full week" = a week whose Monday is on or after the
 * 1st. So week 1 starts on the first Monday ≥ the 1st; week 3 = +14 days.
 * This places tech bonus two weeks out from PAB. Strict equality: only the
 * 3rd week, not 4th+.
 */
export function isTechBonusWeek(weekMonday: Date): boolean {
  const salary = new Date(
    weekMonday.getFullYear(),
    weekMonday.getMonth(),
    weekMonday.getDate() + 8,
  );
  const first = new Date(salary.getFullYear(), salary.getMonth(), 1);
  const dow = first.getDay();
  // Days forward to first Monday ≥ the 1st. Sun=0→1, Mon=1→0, Tue=2→6, …
  const daysForward = (8 - dow) % 7;
  const firstMon = new Date(
    first.getFullYear(),
    first.getMonth(),
    first.getDate() + daysForward,
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
