/**
 * Overtime monitoring for the People tab.
 *
 * Given how many hours an employee has logged so far in their current pay week
 * and the week's [start, end] window, project where they're on track to land if
 * they keep the same daily pace. Overtime is anything past the 40h/week cap
 * (the same threshold the pay engine uses — see REGULAR_WEEK_CAP_SEC in
 * current-pay.ts). Pure + dependency-free so it runs on both server and client.
 *
 * The projection is an ESTIMATE: it assumes a steady pace across the 7-day week
 * and is only meaningful while the week is still in progress. Once the week has
 * ended the "so far" figures ARE the final figures, so `inProgress` is false and
 * the projection collapses to the actuals.
 */

const WEEK_OT_THRESHOLD_HOURS = 40;

export interface OvertimeProjection {
  /** Hours logged so far this week. */
  hoursSoFar: number;
  /** Overtime accrued so far = max(0, hoursSoFar - 40). */
  otSoFar: number;
  /** Whole days elapsed in the week up to and including today (1..7). */
  elapsedDays: number;
  /** Is today inside [weekStart, weekEnd]? Projection only applies when true. */
  inProgress: boolean;
  /** Projected total hours at the current pace (null when the week isn't live). */
  projectedHours: number | null;
  /** Projected overtime = max(0, projectedHours - 40) (null when not live). */
  projectedOt: number | null;
}

function dayDiffInclusive(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.floor((b - a) / 86_400_000) + 1;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function projectOvertime(
  hoursSoFar: number,
  weekStart: Date | null,
  weekEnd: Date | null,
  today: Date,
): OvertimeProjection {
  const hours = Number.isFinite(hoursSoFar) && hoursSoFar > 0 ? hoursSoFar : 0;
  const otSoFar = Math.max(0, hours - WEEK_OT_THRESHOLD_HOURS);

  // Without a resolvable window we can't pace — report actuals only.
  if (!weekStart || !weekEnd) {
    return { hoursSoFar: round1(hours), otSoFar: round1(otSoFar), elapsedDays: 0, inProgress: false, projectedHours: null, projectedOt: null };
  }

  const startT = Date.UTC(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate());
  const endT = Date.UTC(weekEnd.getFullYear(), weekEnd.getMonth(), weekEnd.getDate());
  const todayT = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const inProgress = todayT >= startT && todayT <= endT;

  if (!inProgress) {
    return { hoursSoFar: round1(hours), otSoFar: round1(otSoFar), elapsedDays: 0, inProgress: false, projectedHours: null, projectedOt: null };
  }

  const elapsedDays = Math.min(7, Math.max(1, dayDiffInclusive(weekStart, today)));
  const projectedHours = round1((hours / elapsedDays) * 7);
  const projectedOt = round1(Math.max(0, projectedHours - WEEK_OT_THRESHOLD_HOURS));

  return {
    hoursSoFar: round1(hours),
    otSoFar: round1(otSoFar),
    elapsedDays,
    inProgress: true,
    projectedHours,
    projectedOt,
  };
}
