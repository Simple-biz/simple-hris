/**
 * The Accounting Scoreboard's wire types: what GET /api/accounting-scoreboard returns. Pure, so
 * the client components import these and never touch the server-only module.
 */

import type { PreviewVerdict } from './bonus-preview';
import type { PayrollEvent } from './payroll-cycle';
import type { CollectionEntry, StoredEntry } from './scoring';
import type { SectionKey, SectionSetting } from './sections';

export interface BoardRow {
  id: string;
  sectionKey: SectionKey;
  label: string;
  /** Set when the row IS an HRIS person. */
  workEmail: string | null;
  sortOrder: number;
  /** Archived rows appear only for weeks they have numbers in, and are read-only. */
  archived: boolean;
}

export interface BoardMember {
  workEmail: string;
  addedAt: string;
  addedBy: string;
}

export interface BoardPayload {
  /** The Sunday key of the week shown. */
  weekStart: string;
  lastWeekStart: string;
  /** US Eastern. */
  today: string;
  viewer: { email: string; isManager: boolean };
  settings: SectionSetting[];
  rows: BoardRow[];
  /** This week's and last week's entries. */
  entries: StoredEntry[];
  /** This week's and last week's live collections. */
  collections: CollectionEntry[];
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
