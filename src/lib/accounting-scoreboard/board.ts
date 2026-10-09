/**
 * One number and one stop light per section for a week: what its goal is judged on. The overview
 * tiles and the section headers both read it, so they can never disagree.
 * Pure. Governing doc: docs/features/accounting-scoreboard.md § Scoring, § Stop light.
 */

import type { BoardSection } from './sections';
import { datesFor } from './week';
import {
  amPmSectionStats,
  collectionsWeekStats,
  dailySectionStats,
  problemsWeekStats,
  timeSpanSectionHours,
  winRatio,
  type AmPmRowMeta,
  type CollectionEntry,
  type EntryLookup,
  type ProblemEntry,
} from './scoring';
import { cycleLight, cycleWeek, type PayrollEvent } from './payroll-cycle';
import { goalLight, weekPace, type Light } from './stoplight';
import { cardScore, cycleCardScore, type CardScore } from './team-score';

/** Everything a headline can be computed from. */
export interface BoardContext {
  lookup: EntryLookup;
  collections: readonly Pick<CollectionEntry, 'date' | 'rowId' | 'points'>[];
  /** The payroll problem log (this week and last). */
  problems: readonly Pick<ProblemEntry, 'date' | 'rowId' | 'typeId' | 'count'>[];
  payrollEvents: readonly PayrollEvent[];
  /** The period end of the first cycle ever closed; cycles that ended before it predate Close Pay Cycle. */
  firstClosedPeriodEnd: string | null;
  /** US Eastern date. */
  today: string;
  /** Now, for Payroll Timing's deadlines. */
  nowIso: string;
}

/** What a headline needs from a section, so a built-in and a custom section share one path. */
export type HeadlineSection = Pick<BoardSection, 'kind' | 'days' | 'score' | 'goal'>;

/**
 * - buckets / inbox / open disputes → the section's 0–10 score (buckets and, since 2026-10-07, Open
 *   Disputes: Carla's overall, 10 × Σ completed ÷ Σ(completed + open) over the scored lines; the
 *   "due in 7 days" line is never scored)
 * - outcomes        → the win ratio, 100 × wins ÷ (wins + losses + Pre-arb) by count (Carla, 2026-10-07; Pre-arb is a loss)
 * - collections     → team points
 * - PM buckets      → Σ of the PMs' daily averages (the sheet's WTD AVG total)
 * - payroll timing  → the cycle score, once both checks are decided
 * - payroll problems → the week's problems (log + the old grid's counts)
 * - other daily     → the team's week total
 */
export function sectionHeadline(
  section: HeadlineSection,
  rows: readonly AmPmRowMeta[],
  ctx: BoardContext,
  weekStart: string,
): number | null {
  const dates = datesFor(weekStart, section.days);
  const ids = rows.map((r) => r.id);
  switch (section.kind) {
    case 'am_pm':
      return amPmSectionStats(rows, dates, ctx.lookup, section.score, ctx.today).headline;
    case 'daily':
      return dailySectionStats(ids, dates, ctx.lookup).weekTotal;
    case 'daily_flag':
      return dailySectionStats(ids, dates, ctx.lookup).averageTotal;
    case 'time_span':
      return timeSpanSectionHours(ids, dates, ctx.lookup).total;
    case 'collections': {
      const s = collectionsWeekStats(ids, ctx.collections, dates);
      return s.week.accounts === 0 ? null : s.week.points;
    }
    case 'payroll_cycle':
      return cycleWeek(ctx.payrollEvents, weekStart, ctx.nowIso, ctx.firstClosedPeriodEnd).score;
    case 'amount_count':
      return winRatio(rows, dates, ctx.lookup).ratio;
    case 'problem_log':
      return problemsWeekStats(ids, ctx.problems, ctx.lookup, dates).week;
  }
}

export interface SectionSummary {
  headline: number | null;
  lastHeadline: number | null;
  /** This week, judged on pace for running totals. */
  light: Light;
  /** Last week, judged on the full goal. */
  lastLight: Light;
}

export function summarizeSection(
  section: HeadlineSection,
  rows: readonly AmPmRowMeta[],
  ctx: BoardContext,
  weekStart: string,
  lastWeekStart: string,
): SectionSummary {
  const headline = sectionHeadline(section, rows, ctx, weekStart);
  const lastHeadline = sectionHeadline(section, rows, ctx, lastWeekStart);
  return {
    headline,
    lastHeadline,
    light: weekLight(section, headline, ctx, weekStart),
    lastLight: weekLight(section, lastHeadline, ctx, lastWeekStart, 1),
  };
}

/**
 * A section's stop light for one week. A cycle's comes from its two checks, so "started on time, close not due yet" is
 * green even though the score is not decided. Anything else is its headline against the goal on `pace`: by default the
 * share of the week's days that are over (this week on pace, a past week on its full goal). The History tab calls this
 * for every week, so its bars and the Overview's cards can never disagree.
 */
export function weekLight(
  section: HeadlineSection,
  headline: number | null,
  ctx: BoardContext,
  weekStart: string,
  pace: number = weekPace(datesFor(weekStart, section.days), ctx.today),
): Light {
  if (section.kind === 'payroll_cycle') {
    return cycleLight(cycleWeek(ctx.payrollEvents, weekStart, ctx.nowIso, ctx.firstClosedPeriodEnd));
  }
  return goalLight(section.goal, headline, pace);
}

/**
 * A section's Team Score card for one week (Carla's spec, team-score.ts): Payroll Timing from its two checks, every
 * other section as its headline's % of goal on `pace` (the share of its days that are over; a past week passes 1).
 * The Overview (this week and last) and the History tab (every week) both call this, so they can never disagree.
 */
export function sectionCard(
  section: HeadlineSection,
  headline: number | null,
  ctx: BoardContext,
  weekStart: string,
  pace: number,
): CardScore {
  if (section.kind === 'payroll_cycle') {
    return cycleCardScore(cycleWeek(ctx.payrollEvents, weekStart, ctx.nowIso, ctx.firstClosedPeriodEnd));
  }
  return cardScore(section.goal, headline, pace);
}
