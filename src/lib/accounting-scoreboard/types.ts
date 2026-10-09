/**
 * The Accounting Scoreboard's wire types: what GET /api/accounting-scoreboard returns. Pure, so
 * the client components import these and never touch the server-only module.
 */

import type { PreviewVerdict } from './bonus-preview';
import type { PayrollEvent } from './payroll-cycle';
import type { CollectionEntry, ProblemEntry, StoredEntry } from './scoring';
import type { CustomSection, Outcome, RowSectionKey, SectionSetting, Weekday } from './sections';
import type { BoardRole, GrantRole } from './roles';
import type { FrequencyProgress, TaskFrequency } from './tasks';

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
  /**
   * Who is looking, and their board-local role (roles.ts). A PERMISSION: the client never caches it, and asks
   * `can(viewer.role, action)` for every Setup and delete control.
   */
  viewer: { email: string; role: BoardRole };
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
  /** Admins and Assistants only (they see Setup); null for a Team member. */
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

/** A live Admin or Assistant grant (accounting_scoreboard_roles). Team members are the member list, not grants. */
export interface RoleGrant {
  email: string;
  role: GrantRole;
  grantedBy: string;
  grantedAt: string;
}

export interface RosterPerson {
  name: string;
  department: string;
  workEmail: string;
}

// ---------------------------------------------------------------------------
// Keys (Open item 424): GET /api/accounting-scoreboard/keys, Admins only. Not part of the board read.
// ---------------------------------------------------------------------------

/** One paid platform a person can hold a seat on (accounting_scoreboard_keys). */
export interface ScoreboardKey {
  id: string;
  label: string;
  createdBy: string;
  createdAt: string;
  /** Archived keys are sent so a removed seat still prints its platform's name. */
  archived: boolean;
}

/** One seat (accounting_scoreboard_key_seats). Live while `removedAt` is null; a removed seat is history. */
export interface KeySeat {
  id: string;
  keyId: string;
  email: string;
  givenBy: string;
  givenAt: string;
  removedBy: string | null;
  removedAt: string | null;
}

export interface KeysPayload {
  /** A permission, resolved per request, never cached. */
  viewer: { email: string; role: BoardRole };
  /** Every key, live and archived. */
  keys: ScoreboardKey[];
  /** Every seat, live and removed. */
  seats: KeySeat[];
  /** The board's people (live person rows, Members, role grants): who a seat can be given to. */
  people: TaskPerson[];
}

/** Every error body the scoreboard routes return. */
export interface ApiError {
  error: string;
  code: string;
}

// ---------------------------------------------------------------------------
// Task boards (plan Task 7 + 8, Open item 393): GET /api/accounting-scoreboard/tasks. Not part of the board read.
// ---------------------------------------------------------------------------

/** Someone a task can belong to: a live person row (named by its label), a member, or a role grant. */
export interface TaskPerson {
  email: string;
  name: string;
}

/** A live task. Archived tasks are history and are not sent. */
export interface BoardTask {
  id: string;
  ownerEmail: string;
  title: string;
  frequency: TaskFrequency;
  sortOrder: number;
  createdAt: string;
}

/** A live tick in a task's CURRENT period (the server only sends those). */
export interface TaskCheck {
  taskId: string;
  periodKey: string;
  checkedBy: string;
  checkedAt: string;
}

export interface TasksPayload {
  /** US Eastern: every period is computed from it. */
  today: string;
  /** A permission, resolved per request, never cached. */
  viewer: { email: string; role: BoardRole };
  /** Whose tasks are shown: one person (the viewer's own, or a person an Admin or Assistant picked), or everyone. */
  view: { kind: 'person'; person: TaskPerson; own: boolean } | { kind: 'all' };
  /** The person picker (Admin and Assistant); null for a Team member. */
  people: TaskPerson[] | null;
  tasks: BoardTask[];
  checks: TaskCheck[];
  /** The All view: everyone's live tasks counted together, for the progress message. */
  teamProgress: FrequencyProgress[] | null;
  /** Whether Post to Chat can send (the webhook env is set). Admins only; null for everyone else. */
  chatConfigured: boolean | null;
}
