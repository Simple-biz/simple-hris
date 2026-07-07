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
