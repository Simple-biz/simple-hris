// Cadence helpers for catalog bonuses (weekly vs monthly).
//
// Payroll runs weekly (one Hubstaff CSV per week). A "monthly" catalog bonus
// must therefore pay exactly ONCE per month. To match how PAB already behaves
// ("only attach to the final weekly paystub of the period"), a monthly bonus
// pays on the LAST payroll week of its month.
//
// Payroll weeks are Monday-anchored (period_start is always a Monday ISO date),
// so a month's final payroll week is simply the week whose Monday is in that
// month and whose *next* Monday falls in a different month. This calendar rule
// is deliberately override-free so the manager KPI Calculator and the Payroll
// Wizard agree on "which week is the monthly payout" from the period_start
// alone, with no extra settings fetch.

import type { BonusCadence } from '@/lib/bonus-catalog/types';

export const DEFAULT_BONUS_CADENCE: BonusCadence = 'weekly';

/** Coerce an unknown value into a valid cadence (defensive; legacy ⇒ weekly). */
export function normalizeCadence(value: unknown): BonusCadence {
  return value === 'monthly' ? 'monthly' : 'weekly';
}

/** Parse a 'YYYY-MM-DD' date as a LOCAL calendar date (not UTC), matching the
 *  rest of the payroll code (avoids the UTC-midnight day-shift on `new Date`). */
function parseLocalIso(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * True when `mondayIso` (a payroll week's Monday, YYYY-MM-DD) is the LAST
 * payroll week of its calendar month — i.e. the week a monthly bonus pays out.
 * The next Monday-anchored week starts in a different month.
 */
export function isFinalPayrollWeekOfMonth(mondayIso: string): boolean {
  const monday = parseLocalIso(mondayIso);
  if (!monday) return false;
  const nextMonday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7);
  return nextMonday.getMonth() !== monday.getMonth();
}

/**
 * The calendar month a payroll week belongs to, as a comparable `year*12+month`
 * ordinal. `null` when the ISO date can't be parsed.
 *
 * The week is identified by the month of its **owning Monday**, the rule this
 * file's monthly-payout logic above is written against ("the week whose Monday is
 * in that month"). Hubstaff weekly files start on a **Sunday**, so a Sunday date
 * is walked FORWARD one day to reach that Monday — never backward, which is the
 * bug that once attributed the Jul 5–11 file to June (see `fileMonth` in
 * `PayrollWizard.tsx`). A date that is already a Monday is used as-is.
 */
export function payrollWeekMonthOrdinal(weekStartIso: string): number | null {
  const start = parseLocalIso(weekStartIso);
  if (!start) return null;
  const dow = start.getDay();
  const monday =
    dow === 0
      ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1)
      : new Date(start.getFullYear(), start.getMonth(), start.getDate() - (dow - 1));
  return monday.getFullYear() * 12 + monday.getMonth();
}

/**
 * The plain calendar month of an ISO date as a `year*12+month` ordinal, with no
 * week reasoning applied. `null` when unparseable.
 *
 * This is the right rule for a **monthly** period's `period_start`, which is a
 * month anchor rather than a week start — and it is how the period's own label is
 * rendered (`toLocaleDateString` month + year). Deriving the scoping decision and
 * the visible label the same way is the point: anything else could filter on a
 * month different from the one on screen.
 *
 * Do NOT use {@link payrollWeekMonthOrdinal} for a month anchor. `2026-08-01` is a
 * Saturday, so the owning-Monday walk lands on Jul 27 and reports JULY for a
 * period the UI calls "August 2026".
 */
export function calendarMonthOrdinal(iso: string): number | null {
  const d = parseLocalIso(iso);
  if (!d) return null;
  return d.getFullYear() * 12 + d.getMonth();
}

/** How a monthly bonus period sits relative to the payroll week being viewed. */
export type MonthlyPeriodRelation = 'same' | 'before' | 'after' | 'unknown';

/**
 * Place a monthly bonus period's month against the month owning `weekStartIso`.
 *
 * Exists because monthly HSL/KPI periods used to be picked as "the latest
 * ready/locked one, full stop" — so replaying a July week showed **August's**
 * card and its total. A monthly period from a month the viewed week has not
 * reached is not that week's bonus, and Accounting applies these by hand from
 * the Adjustment column, so the wrong month is an actionable wrong number.
 *
 * `'unknown'` (no week to compare against, or an unparseable date) means the
 * caller must not scope — there is nothing to scope to, and dropping candidates
 * on a failed parse would hide a real bonus.
 *
 * The two sides use DIFFERENT month rules on purpose, because they are different
 * kinds of date: the week is placed by its owning Monday
 * ({@link payrollWeekMonthOrdinal}), the period by its plain calendar month
 * ({@link calendarMonthOrdinal}), which is also how its label is rendered.
 *
 * @param periodStartIso the monthly period's own `period_start` (a month anchor)
 * @param weekStartIso   the viewed week's start, Sunday-anchored file dates included
 */
export function relateMonthlyPeriodToWeek(
  periodStartIso: string,
  weekStartIso: string | null,
): MonthlyPeriodRelation {
  if (!weekStartIso) return 'unknown';
  const week = payrollWeekMonthOrdinal(weekStartIso);
  const period = calendarMonthOrdinal(periodStartIso);
  if (week == null || period == null) return 'unknown';
  if (period === week) return 'same';
  return period > week ? 'after' : 'before';
}
