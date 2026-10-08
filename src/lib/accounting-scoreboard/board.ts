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
  if (section.kind === 'payroll_cycle') {
    // A cycle's light comes from its two checks, so "started on time, close not due yet" is green
    // even though the score is not decided.
    return {
      headline,
      lastHeadline,
      light: cycleLight(cycleWeek(ctx.payrollEvents, weekStart, ctx.nowIso, ctx.firstClosedPeriodEnd)),
      lastLight: cycleLight(cycleWeek(ctx.payrollEvents, lastWeekStart, ctx.nowIso, ctx.firstClosedPeriodEnd)),
    };
  }
  const pace = weekPace(datesFor(weekStart, section.days), ctx.today);
  return {
    headline,
    lastHeadline,
    light: goalLight(section.goal, headline, pace),
    lastLight: goalLight(section.goal, lastHeadline, 1),
  };
}
