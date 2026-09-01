import { isFinalPabWeek, pabMonthFromWeekStart } from './dispatch-bonuses';
import { resolvePabRangeForMonth, type PabOverridesMap } from '@/lib/pab-period-settings';

/**
 * Is this payroll file week the PAB PAYOUT week — the one week whose dispatch
 * carries the Perfect Attendance Bonus?
 *
 * This is the SAME verdict the money path reaches, assembled from the same two
 * shared pieces and nothing else:
 *
 * 1. `pabMonthFromWeekStart` — the week's owning PAB month (a Sunday file-start's
 *    owning Monday is the NEXT day; walking backward was the "PAB still on after
 *    payout week" bug of 2026-07-17).
 * 2. `isFinalPabWeek` — containment: the week CONTAINS the period end, never
 *    `weekEnd >= periodEnd`.
 *
 * The period end resolves exactly as the wizard's dispatch memo resolves it: the
 * legacy manual range when one is validly set, else the month's override from
 * `pab_period_overrides`, else the code default (`getPabMonthRange`).
 *
 * Used to gate the Payroll Wizard's PAB step tab: the tab exists only on the
 * payout week. Because it keys on the SELECTED FILE WEEK — not the wall clock —
 * replaying a past payout week still shows the step (read-only), and a week that
 * carries no PAB money never shows it. Note the standing landmine from
 * `pab-calendars-sun-sat-sweep`: a month nobody overrides falls back to the
 * Mon→Fri default window, which moves both the money and this tab.
 */
export function isPabPayoutWeekForRange(
  weekStart: Date | null,
  weekEnd: Date | null,
  overrides: PabOverridesMap,
  manualEnd: Date | null,
): boolean {
  if (!weekStart || !weekEnd) return false;
  const { year, month } = pabMonthFromWeekStart(weekStart);
  const periodEnd = manualEnd ?? resolvePabRangeForMonth(year, month, overrides).end;
  return isFinalPabWeek(weekStart, weekEnd, periodEnd);
}
