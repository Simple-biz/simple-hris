/**
 * The Team Score (Carla's "Team Score & Overview Edits Spec", 2026-10-07): one 0–100 number on the
 * Overview that rolls up every group with a goal. Display only: it pays no one.
 * Governing doc: docs/features/accounting-scoreboard.md § Team Score.
 *
 * 1. Card score: a card's "% of goal", capped at 100 so one strong card can't hide a weak one. It is
 *    judged on the SAME pace as the card's stop light (stoplight.ts), so the two always agree (Carla:
 *    "Use the same pace logic the cards already use to call On track / Close / Behind").
 * 2. Group score: the mean of the scored cards on one tab. Chargebacks has two (Open Disputes and
 *    Outcomes) and counts once.
 * 3. Team Score: the weighted mean of the group scores, every weight 1, one decimal.
 *
 * A card with no data, no goal, or nothing to judge yet is LEFT OUT, never counted as 0.
 *
 * Pure.
 */

import type { GoalRule } from './sections';
import { isDecided, isOnTime, SCORE_WEIGHTS, type CheckState } from './payroll-cycle';
import type { Light } from './stoplight';

/**
 * Why a card has (or has no) score:
 * - `scored`     a number
 * - `no_goal`    no goal set, or an "at least 0" goal (Carla: "treated as no goal"): not scored
 * - `waiting`    nothing typed yet: "Waiting on data"
 * - `too_early`  a running total under its full goal before any day of the week is over (Monday):
 *                its pace goal is 0, and its light says "No call yet"
 */
export type CardScoreReason = 'scored' | 'no_goal' | 'waiting' | 'too_early';

export interface CardScore {
  /** 0–100, unrounded; null unless `reason` is `scored`. */
  score: number | null;
  reason: CardScoreReason;
}

const NOT_SCORED = (reason: Exclude<CardScoreReason, 'scored'>): CardScore => ({ score: null, reason });
const scored = (ratio: number): CardScore => ({ score: Math.min(Math.max(ratio, 0), 1) * 100, reason: 'scored' });

/**
 * A card's 0–100 "% of goal":
 * - at least, a score / average / ratio → MIN(actual ÷ goal, 1) × 100
 * - at least, a running week total      → MIN(actual ÷ (goal × pace), 1) × 100
 * - below, an average                   → MIN(goal ÷ actual, 1) × 100; 0 = 100
 * - below, a running week total         → MIN(goal × pace ÷ actual, 1) × 100; 0 = 100. Paced like its
 *   light: Carla's table gave Payroll Problems the unpaced form, which would read 100 while its light
 *   says Close, and her spec's rule is that the two agree.
 * `pace` is the share of the section's days that are over (weekPace); a past week passes 1.
 */
export function cardScore(goal: GoalRule | undefined, value: number | null, pace: number): CardScore {
  if (!goal || (goal.direction === 'at_least' && goal.value <= 0)) return NOT_SCORED('no_goal');
  if (value === null || !Number.isFinite(value)) return NOT_SCORED('waiting');
  const p = goal.measure === 'team_week' ? Math.min(Math.max(pace, 0), 1) : 1;
  if (goal.direction === 'at_least') {
    if (value >= goal.value) return scored(1);
    if (p === 0) return NOT_SCORED('too_early');
    return scored(value / (goal.value * p));
  }
  if (value <= 0) return scored(1);
  if (p === 0) return value < goal.value ? NOT_SCORED('too_early') : scored(goal.value / value);
  return scored((goal.value * p) / value);
}

/**
 * Payroll Timing (Carla: "On time = 100, late = 0"): the share of its JUDGED checks that were on time,
 * weighted like the cycle score (start 25, close 75). Start on time with the close still ahead = 100;
 * both judged = the cycle score itself. Nothing judged (pending, or `no_record`: never judged) = left out.
 */
export function cycleCardScore(week: { start: CheckState; close: CheckState }): CardScore {
  const checks = [
    { state: week.start, weight: SCORE_WEIGHTS.start },
    { state: week.close, weight: SCORE_WEIGHTS.close },
  ].filter((c) => isDecided(c.state));
  if (!checks.length) return NOT_SCORED('waiting');
  const total = checks.reduce((s, c) => s + c.weight, 0);
  const good = checks.filter((c) => isOnTime(c.state)).reduce((s, c) => s + c.weight, 0);
  return scored(good / total);
}

export interface TeamCard {
  /** The tab the card's grid sits on (tabIdFor): its group. */
  groupId: string;
  /** The tab's label, for the breakdown. */
  groupLabel: string;
  card: CardScore;
}

export interface GroupScore {
  groupId: string;
  label: string;
  /** The mean of the group's scored cards, unrounded. */
  score: number;
  /** How many of its cards were scored. */
  cards: number;
}

export interface TeamScore {
  /** 0–100, one decimal; null when no group has a scored card. */
  score: number | null;
  light: Light;
  /** The groups that count, in tab order. */
  groups: GroupScore[];
}

/** Carla's default: every group weighs 1. A group missing here weighs 1. */
export const GROUP_WEIGHTS: Readonly<Record<string, number>> = {};

/** The Team Score's own bands (Carla): 90–100 On track, 75–89.9 Close, below 75 Behind. */
export const TEAM_BANDS = { green: 90, amber: 75 } as const;

export function teamLight(score: number | null): Light {
  if (score === null || !Number.isFinite(score)) return 'none';
  if (score >= TEAM_BANDS.green) return 'green';
  if (score >= TEAM_BANDS.amber) return 'amber';
  return 'red';
}

export function teamScore(cards: readonly TeamCard[]): TeamScore {
  const order: string[] = [];
  const byGroup = new Map<string, { label: string; scores: number[] }>();
  for (const c of cards) {
    if (!byGroup.has(c.groupId)) {
      byGroup.set(c.groupId, { label: c.groupLabel, scores: [] });
      order.push(c.groupId);
    }
    if (c.card.score !== null) byGroup.get(c.groupId)!.scores.push(c.card.score);
  }
  const groups: GroupScore[] = order
    .map((groupId) => ({ groupId, ...byGroup.get(groupId)! }))
    .filter((g) => g.scores.length > 0)
    .map((g) => ({ groupId: g.groupId, label: g.label, score: g.scores.reduce((s, v) => s + v, 0) / g.scores.length, cards: g.scores.length }));
  if (!groups.length) return { score: null, light: 'none', groups };
  const weight = (id: string) => GROUP_WEIGHTS[id] ?? 1;
  const totalWeight = groups.reduce((s, g) => s + weight(g.groupId), 0);
  const score = Math.round((10 * groups.reduce((s, g) => s + weight(g.groupId) * g.score, 0)) / totalWeight) / 10;
  return { score, light: teamLight(score), groups };
}
