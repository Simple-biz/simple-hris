/**
 * The Accounting Scoreboard's wire types: what GET /api/accounting-scoreboard returns. Pure, so
 * the client components import these and never touch the server-only module.
 */

import type { PreviewVerdict } from './bonus-preview';
import type { PayrollEvent } from './payroll-cycle';
import type { CollectionEntry, ProblemEntry, StoredEntry } from './scoring';
import type { CustomSection, Outcome, RowSectionKey, SectionSetting, Weekday } from './sections';

export interface BoardRow {
  id: string;
  sectionKey: RowSectionKey;
  /** Set on a custom section's row only (section_key 'custom'). */
  customSectionId: string | null;
  label: string;
  /** Set when the row IS an HRIS person. */
  workEmail: string | null;
  sortOrder: number;
  /** Archived rows appear only for weeks they have numbers in, and are read-only. */
  archived: boolean;
  /** Buckets only: the weekday a weekday Collections bucket is worked. Its score is Pending until that day's PM. */
  bucketDay: Weekday | null;
  /** Open Disputes only: this line counts the disputes due in the next 7 days, and is called out. */
  dueSoon: boolean;
  /** Chargeback Outcomes only: counted as a win or a loss in the win ratio; null = neither (Pre-arb). */
  outcome: Outcome | null;
}

export interface BoardMember {
  workEmail: string;
  addedAt: string;
  addedBy: string;
}

/** A Payroll Problems type (accounting_scoreboard_problem_types). Archived types stay for old lines. */
export interface ProblemType {
  id: string;
  label: string;
  sortOrder: number;
  archived: boolean;
}

export interface BoardPayload {
  /** The Sunday key of the week shown. */
  weekStart: string;
  lastWeekStart: string;
  /** US Eastern. */
  today: string;
  viewer: { email: string; isManager: boolean };
  settings: SectionSetting[];
  /** Live custom sections, switched on or off (archived ones are not sent). */
  customSections: CustomSection[];
  rows: BoardRow[];
  /** This week's and last week's entries. */
  entries: StoredEntry[];
  /** This week's and last week's live collections, each with its Payment Verified tick. */
  collections: CollectionEntry[];
  /** This week's and last week's live payroll problem lines. */
  problems: ProblemEntry[];
  /** Every problem type, live first; archived ones are sent so old lines still print their type. */
  problemTypes: ProblemType[];
  /** PM Buckets: the latest day any meeting was ticked, ever (the No Meeting Streak counts from it). */
  lastMeetingDate: string | null;
  history: {
    allTimeByRow: Record<string, number>;
    record: { weekStart: string; points: number } | null;
    /** Date of the first logged collection; null before any. */
    liveSince: string | null;
  };
  /** Managers only. */
  members: BoardMember[] | null;
  bonus: PreviewVerdict;
  /**
   * The Payroll Wizard's Start Processing stamps (each names the cycle it was on) and the pay-cycle
   * closes/reopens, from three weeks before the week shown onward (audit_log; action, time, cycle
   * file and period only). Payroll Timing is computed from these and nothing is typed
   * (payroll-cycle.ts).
   */
  payrollEvents: PayrollEvent[];
  /** The period end of the first cycle ever closed; a cycle that ended before it predates Close Pay Cycle. */
  firstClosedPeriodEnd: string | null;
  generatedAt: string;
}

export interface RosterPerson {
  name: string;
  department: string;
  workEmail: string;
}

/** Every error body the scoreboard routes return. */
export interface ApiError {
  error: string;
  code: string;
}
