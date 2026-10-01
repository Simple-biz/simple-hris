/**
 * One number per section for a week, the number its goal is judged on. The overview tiles and the
 * section headers both read it, so they can never disagree.
 * Pure. Governing doc: docs/features/accounting-scoreboard.md § Scoring.
 */

import type { ResolvedSection } from './sections';
import { datesFor } from './week';
import {
  amPmSectionStats,
  collectionsWeekStats,
  dailySectionStats,
  goalMet,
  timeSpanSectionHours,
  type CollectionEntry,
  type EntryLookup,
} from './scoring';

/**
 * - buckets / inbox → the section's 1–10 score
 * - chargebacks     → net cleared, Σ(AM − PM)
 * - collections     → team points
 * - PM buckets      → Σ of the PMs' daily averages (the sheet's WTD AVG total)
 * - payroll timing  → team hours
 * - other daily     → the team's week total
 */
export function sectionHeadline(
  section: ResolvedSection,
  rowIds: readonly string[],
  lookup: EntryLookup,
  collections: readonly Pick<CollectionEntry, 'date' | 'rowId' | 'points'>[],
  weekStart: string,
  today: string,
): number | null {
  const dates = datesFor(weekStart, section.days);
  switch (section.kind) {
    case 'am_pm':
      return amPmSectionStats(rowIds, dates, lookup, section.score, today).headline;
    case 'daily':
      return dailySectionStats(rowIds, dates, lookup).weekTotal;
    case 'daily_flag':
      return dailySectionStats(rowIds, dates, lookup).averageTotal;
    case 'time_span':
      return timeSpanSectionHours(rowIds, dates, lookup).total;
    case 'collections': {
      const s = collectionsWeekStats(rowIds, collections, dates);
      return s.week.accounts === 0 ? null : s.week.points;
    }
  }
}

export interface SectionSummary {
  headline: number | null;
  lastHeadline: number | null;
  met: boolean | null;
  lastMet: boolean | null;
}

export function summarizeSection(
  section: ResolvedSection,
  rowIds: readonly string[],
  lookup: EntryLookup,
  collections: readonly Pick<CollectionEntry, 'date' | 'rowId' | 'points'>[],
  weekStart: string,
  lastWeekStart: string,
  today: string,
): SectionSummary {
  const headline = sectionHeadline(section, rowIds, lookup, collections, weekStart, today);
  const lastHeadline = sectionHeadline(section, rowIds, lookup, collections, lastWeekStart, today);
  return { headline, lastHeadline, met: goalMet(section.goal, headline), lastMet: goalMet(section.goal, lastHeadline) };
}
