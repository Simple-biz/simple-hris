/**
 * One number and one stop light per section for a week: what its goal is judged on. The overview
 * tiles and the section headers both read it, so they can never disagree.
 * Pure. Governing doc: docs/features/accounting-scoreboard.md § Scoring, § Stop light.
 */

import type { ResolvedSection } from './sections';
import { datesFor } from './week';
import {
  amPmSectionStats,
  collectionsWeekStats,
  dailySectionStats,
  timeSpanSectionHours,
  type CollectionEntry,
  type EntryLookup,
} from './scoring';
import { cycleLight, cycleWeek, type PayrollEvent } from './payroll-cycle';
import { goalLight, weekPace, type Light } from './stoplight';

/** Everything a headline can be computed from. */
export interface BoardContext {
  lookup: EntryLookup;
  collections: readonly Pick<CollectionEntry, 'date' | 'rowId' | 'points'>[];
  payrollEvents: readonly PayrollEvent[];
  /** The period end of the first cycle ever closed; cycles that ended before it predate Close Pay Cycle. */
  firstClosedPeriodEnd: string | null;
  /** US Eastern date. */
  today: string;
  /** Now, for Payroll Timing's deadlines. */
  nowIso: string;
}

/**
 * - buckets / inbox → the section's 1–10 score
 * - chargebacks     → net cleared, Σ(AM − PM)
 * - collections     → team points
 * - PM buckets      → Σ of the PMs' daily averages (the sheet's WTD AVG total)
 * - payroll timing  → the cycle score, once both checks are decided
 * - other daily     → the team's week total
 */
export function sectionHeadline(
  section: ResolvedSection,
  rowIds: readonly string[],
  ctx: BoardContext,
  weekStart: string,
): number | null {
  const dates = datesFor(weekStart, section.days);
  switch (section.kind) {
    case 'am_pm':
      return amPmSectionStats(rowIds, dates, ctx.lookup, section.score, ctx.today).headline;
    case 'daily':
      return dailySectionStats(rowIds, dates, ctx.lookup).weekTotal;
    case 'daily_flag':
      return dailySectionStats(rowIds, dates, ctx.lookup).averageTotal;
    case 'time_span':
      return timeSpanSectionHours(rowIds, dates, ctx.lookup).total;
    case 'collections': {
      const s = collectionsWeekStats(rowIds, ctx.collections, dates);
      return s.week.accounts === 0 ? null : s.week.points;
    }
    case 'payroll_cycle':
      return cycleWeek(ctx.payrollEvents, weekStart, ctx.nowIso, ctx.firstClosedPeriodEnd).score;
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
  section: ResolvedSection,
  rowIds: readonly string[],
  ctx: BoardContext,
  weekStart: string,
  lastWeekStart: string,
): SectionSummary {
  const headline = sectionHeadline(section, rowIds, ctx, weekStart);
  const lastHeadline = sectionHeadline(section, rowIds, ctx, lastWeekStart);
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
