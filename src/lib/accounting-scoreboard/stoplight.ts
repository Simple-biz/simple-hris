/**
 * The stop light. Kane, 2026-10-01: *"if its performing badly lets make the feel look that we are
 * failing kind of RED and if its GOOD then its green and orange is for middle … kinda like a stop
 * light"*. Governing doc: docs/features/accounting-scoreboard.md § Stop light.
 *
 * - green = the goal is met (or on pace to be)
 * - amber = close: within 80% of an "at least" goal, or under 120% of a "below" goal. Amber is the
 *   stop light's middle and ui-standards § 6.3's "caution" tone.
 * - red   = behind
 * - none  = nothing to judge yet (no numbers, no goal, or too early in the week). Absence is not a
 *   colour (ui-standards § 12.5).
 *
 * THIS week's running totals (team_week measures) are judged ON PACE: against goal × the share of
 * the section's days that are over. Otherwise every Monday would be red. A past week is judged on
 * the full goal. Averages and scores are never paced.
 *
 * Pure.
 */

import type { GoalRule } from './sections';

export type Light = 'green' | 'amber' | 'red' | 'none';

/** "Close" is within this share of an at-least goal (and 2 − this of a below goal). */
export const AMBER_BAND = 0.8;

/** Share of `dates` that are over (strictly before `today`): 1 for a past week, 0 for a future one. */
export function weekPace(dates: readonly string[], today: string): number {
  if (!dates.length) return 1;
  return dates.filter((d) => d < today).length / dates.length;
}

export function goalLight(goal: GoalRule | undefined, value: number | null, pace = 1): Light {
  if (!goal || value === null || !Number.isFinite(value)) return 'none';
  const paced = goal.measure === 'team_week';
  const p = paced ? Math.min(Math.max(pace, 0), 1) : 1;

  if (goal.direction === 'at_least') {
    if (value >= goal.value) return 'green';
    if (p === 0) return 'none';
    const target = goal.value * p;
    if (value >= target) return 'green';
    if (value >= target * AMBER_BAND) return 'amber';
    return 'red';
  }

  // "below": judged against the allowance so far (goal × pace). A running total can only grow, so going
  // over the FULL goal is final: it is never green again, and never better than being over pace. (Until
  // 2026-10-07 a paced week over the full goal returned amber before the pace check: 15 of 20 by
  // Wednesday read Behind while 21 read Close, so more problems looked better.)
  if (p === 0) {
    // Before any day is over there is no allowance yet: only the full goal can be judged.
    if (value < goal.value) return 'none';
    return value < goal.value * (2 - AMBER_BAND) ? 'amber' : 'red';
  }
  const allowance = goal.value * p;
  if (value < allowance) return 'green';
  if (value < allowance * (2 - AMBER_BAND)) return 'amber';
  return 'red';
}

export const LIGHT_LABEL: Record<Light, string> = {
  green: 'On track',
  amber: 'Close',
  red: 'Behind',
  none: 'No call yet',
};
