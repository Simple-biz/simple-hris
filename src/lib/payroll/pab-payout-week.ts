import { isFinalPabWeek, pabMonthFromWeekStart } from './dispatch-bonuses';
import { resolvePabRangeForMonth, type PabOverridesMap } from '@/lib/pab-period-settings';

/**
 * THE PAB PAYOUT RULE (Kane, 2026-09-08 — supersedes the containment rule of
 * 2026-07-17):
 *
 *   The Perfect Attendance Bonus pays on the payroll week AFTER the one that
 *   closes the PAB period. It is never combined with the period-end week.
 *
 * So the Aug 2 – Aug 29 period closes on the Aug 23–29 file and pays on the
 * Aug 30 – Sep 5 file. The old rule paid it on Aug 23–29 (the week CONTAINING
 * the period end); that week is now the last week of the period, not its
 * paycheck.
 *
 * ── Why this is more than "shift the gate one week" ────────────────────────
 * The payout week almost always belongs to the NEXT owning month, so the week
 * cannot answer "which PAB month am I paying?" from its own Monday any more:
 *
 *   period Jul 6 – Jul 31   closes Jul 26 – Aug 1   pays Aug 2 – Aug 8   → JULY
 *   period Aug 2 – Aug 29   closes Aug 23 – Aug 29  pays Aug 30 – Sep 5  → AUGUST
 *   period Sep 7 – Oct 2    closes Sep 27 – Oct 3   pays Oct 4 – Oct 10  → SEPTEMBER
 *
 * August is the ONE coincidence — its custom window ends on a Saturday, so the
 * following week still opens on an August Monday. Read the paid month off the
 * week's own start and every other month pays the wrong period's bonus (or
 * none, the next period being unfinished). `pabMonthPaidByWeek` answers it by
 * stepping back a week first; every caller that needs the month must use it.
 *
 * Assembled from the same two shared pieces as before, and nothing else:
 *
 * 1. `pabMonthFromWeekStart` — a week's owning PAB month (a Sunday file-start's
 *    owning Monday is the NEXT day; walking backward was the "PAB still on
 *    after the payout week" bug of 2026-07-17).
 * 2. `isFinalPabWeek` — containment: a week CONTAINS the period end. That is
 *    now the CLOSING week, one week before the paycheck.
 *
 * The period end resolves exactly as the wizard's dispatch memo resolves it:
 * the legacy manual range when one is validly set, else the month's override
 * from `pab_period_overrides`, else the code default (`getPabMonthRange`).
 *
 * Every surface that decides "PAB pays here" reads this module: the Payroll
 * Wizard's staged bonus and step-4 tab, Payment Dispatch current-pay, the
 * member monthly modal, the Employee Dashboard, the HSL week snapshot, Penny's
 * employee answers and the interns' week server. Because it keys on the
 * SELECTED FILE WEEK — not the wall clock — replaying a past payout week still
 * shows it, and a week that carries no PAB never does. Standing landmine from
 * `pab-calendars-sun-sat-sweep`: a month nobody overrides falls back to the
 * Mon→Fri default window, which moves both the money and this verdict.
 */

/** Same calendar day, `days` away — local midnight, no timezone drift. */
function shiftDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

/**
 * The PAB month a payroll week PAYS — the owning month of the week BEFORE it,
 * because the paycheck follows the closing week. Never read the paid month off
 * the payout week's own Monday: from September 2026 on it names the wrong month.
 */
export function pabMonthPaidByWeek(weekStart: Date): { year: number; month: number } {
  return pabMonthFromWeekStart(shiftDays(weekStart, -7));
}

export type PabPayoutVerdict = {
  /** This payroll week carries the PAB. */
  pays: boolean;
  /** The PAB month being paid (or, when `pays` is false, the month that would be). */
  year: number;
  month: number;
  /** Resolved end of that month's PAB period. */
  periodEnd: Date;
};

/**
 * The full verdict for a payroll week: does it pay, and for which PAB month.
 * Callers that stage money need both — the month picks the eligibility window,
 * the exclusions and the paystub's `pab_evaluation` label.
 */
export function pabPayoutForWeek(
  weekStart: Date,
  weekEnd: Date,
  overrides: PabOverridesMap,
  manualEnd: Date | null,
): PabPayoutVerdict {
  // Step back to the week this paycheck settles, and judge THAT week against
  // its own owning month's period end.
  const closingStart = shiftDays(weekStart, -7);
  const closingEnd = shiftDays(weekEnd, -7);
  const { year, month } = pabMonthFromWeekStart(closingStart);
  const periodEnd = manualEnd ?? resolvePabRangeForMonth(year, month, overrides).end;
  return { pays: isFinalPabWeek(closingStart, closingEnd, periodEnd), year, month, periodEnd };
}

/**
 * Is this payroll file week the PAB PAYOUT week? Convenience wrapper over
 * `pabPayoutForWeek` for the callers that only gate and never label.
 */
export function isPabPayoutWeekForRange(
  weekStart: Date | null,
  weekEnd: Date | null,
  overrides: PabOverridesMap,
  manualEnd: Date | null,
): boolean {
  if (!weekStart || !weekEnd) return false;
  return pabPayoutForWeek(weekStart, weekEnd, overrides, manualEnd).pays;
}

/**
 * The payroll week that pays a period ending `periodEnd` — the week after the
 * one containing it. For disclosure ("PAB pays Aug 30 – Sep 5"), never a gate:
 * gates compare the week they are handed, they do not construct one.
 */
export function pabPayoutWeekForPeriodEnd(periodEnd: Date): { start: Date; end: Date } {
  // Sun–Sat payroll weeks: back up to the Sunday on/before the period end to
  // find the CLOSING week, then step one week on.
  const closingStart = shiftDays(periodEnd, -periodEnd.getDay());
  const start = shiftDays(closingStart, 7);
  return { start, end: shiftDays(start, 6) };
}
