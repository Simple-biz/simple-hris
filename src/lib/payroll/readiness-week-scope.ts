/**
 * Week-scoping predicates for the Payroll Readiness roster: a readiness period
 * must only contain people who were on board during that week. Someone whose
 * master Start Date is AFTER the week's end (a future hire, or any hire made
 * after a past week being viewed) must not appear in that week's lists or
 * denominators.
 *
 * Pure — no I/O, no server-only — so `node:test` can exercise every branch
 * (same split as readiness-score.ts vs payroll-readiness.ts).
 */

import { weekEndFromStart } from '@/lib/payroll/manila-week';

/**
 * True when this person had not yet started during the week in view and can be
 * dropped from the bank list and its denominators.
 *
 * - `onPayroll` (any alias has hours in the week's Hubstaff file) always wins:
 *   a stale/wrong start date must never hide someone actually being paid —
 *   same fail-safe shape as the off-board guard in buildMissingBank.
 * - A missing/unparseable start date fails safe: the person stays listed
 *   (over-flagging is this dimension's existing direction).
 */
export function isFutureHireForWeek(
  startDateIso: string | null,
  weekStart: string,
  onPayroll: boolean,
): boolean {
  if (onPayroll) return false;
  if (!startDateIso) return false;
  return startDateIso > weekEndFromStart(weekStart);
}

/** True when a known start date lands strictly after the week in view — used to
 *  hide onboarding-pipeline exception rows from a week that predates the hire.
 *  Null (dateless pipeline row) → false: can't place it in time, keep visible. */
export function startsAfterWeek(startIso: string | null, weekStart: string): boolean {
  if (!startIso) return false;
  return startIso > weekEndFromStart(weekStart);
}
