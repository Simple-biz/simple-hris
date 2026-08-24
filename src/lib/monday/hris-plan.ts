/**
 * Monday.com — Simple HRIS project plan (source of truth for the board sync).
 *
 * Derived from the 2026-07-24 full-history commit audit (0f2d75e…ee837fc, 474
 * commits) scored on the dev-resources.simple.biz/story-points Fibonacci scale.
 * Rule: a single-item score of 8+ makes an item an EPIC (Roadmap & Epics board);
 * below 8 it is a SPRINT TASK. Epic SP carries the rollup of sub-features.
 *
 * "Sync board now" (Admin → Design & Specifications) reconciles the live board
 * against THIS file: items missing on the board are created; existing items get
 * their structure patched (SP, type, sprint, quarter, relations). Status and
 * Actual SP of existing items are NEVER overwritten — the board owns execution
 * state. To add newly shipped work to Monday, append it here and press the button.
 */

export const MONDAY_BOARDS = {
  projects: '18419115953',
  epics: '18419115960',
  tasks: '18419115956',
} as const;

export const HRIS_PROJECT_ITEM_ID = '12456313508'; // "Simple HRIS Platform"

/** Roadmap & Epics groups + columns */
export const EPIC_GROUPS: Record<Quarter, string> = {
  Q1: 'group_mm4m8bpz',
  Q2: 'group_mm4menkt',
  Q3: 'group_mm4m3g77',
  Q4: 'group_mm4m51xd',
};
export const EPIC_COLS = {
  owner: 'multiple_person_mm4mp38m',
  status: 'color_mm4mkvd1', // 0 Planned · 1 In Progress · 2 Shipped · 3 Cancelled
  quarter: 'color_mm4mxc16', // 0 Q1 · 1 Q2 · 2 Q3 · 3 Q4
  sp: 'numeric_mm4m852x',
  project: 'board_relation_mm4m27ps',
  linkedTasks: 'board_relation_mm4mhvs2',
} as const;

/** Sprint Tasks groups + columns */
export const TASK_GROUPS = {
  // Sprints 17-23 mirrored from the live board 2026-08-19 so pre-sprint Backlog history can be filed
  // at all. S18 carries no HRIS row but MUST exist anyway: taskSprintAttribution() ends a sprint the
  // day before the next one STARTS, so omitting S18 would let S17 absorb Apr 12-27 and silently
  // accept a date that belongs to a sprint the plan cannot name.
  S17: 'group_mm5epday',
  S18: 'group_mm5es7e4',
  S19: 'group_mm5exy0s',
  S20: 'group_mm5ey2ey',
  S21: 'group_mm5e6tt3',
  S22: 'group_mm57v6x0',
  S23: 'group_mm57wbb7',
  S24: 'group_mm4my9wx',
  S25: 'group_mm4m16sq',
  S26: 'group_mm5s2dw1',
  S27: 'group_mm66ce8q',
  BL: 'group_mm4m1eqp', // Backlog
} as const;
export const TASK_COLS = {
  owner: 'multiple_person_mm4m9frz',
  type: 'color_mm4m786c', // 0 Feature · 1 Bug · 2 Integration · 3 n8n Workflow · 5 Chore · 6 Spike · 7 PR Review
  status: 'color_mm4mts9b', // 0 Ready to Start · 1 In Progress · 2 Waiting for Review · 3 Pending Deploy · 4 Done
  priority: 'color_mm4m2j0z', // 0 Critical · 1 High · 2 Medium · 3 Low
  estimatedSp: 'numeric_mm4mpgqk',
  actualSp: 'numeric_mm4mevqb',
  sprint: 'color_mm4mw08e', // 0 Sprint 24 · 1 Sprint 25 · 2 Backlog · 13 Sprint 26
  project: 'board_relation_mm4mrsvm',
  epic: 'board_relation_mm4mp3yb',
  /**
   * Completed Date. The reconciler never writes it — a date on a row that is not Done would be an
   * invented record. Owned by the monday-board-sync skill's corrector, Done rows only.
   */
  completed: 'date_mm5qj7vm',
} as const;

/** Projects Portfolio columns (the HRIS project item) */
export const PROJECT_COLS = {
  status: 'color_mm4mfemh', // 4 = Live
  totalSp: 'numeric_mm4mw98f',
  spCompleted: 'numeric_mm4mkb4y',
  sprintTasks: 'board_relation_mm4mwppe',
} as const;

export type Quarter = 'Q1' | 'Q2' | 'Q3' | 'Q4';
export type EpicStatus = 'Planned' | 'In Progress' | 'Shipped' | 'Cancelled';
export type TaskType =
  | 'Feature'
  | 'Bug'
  | 'Integration'
  | 'n8n Workflow'
  | 'Chore'
  | 'Spike'
  | 'PR Review';
export type TaskSprint = keyof typeof TASK_GROUPS;
export type TaskPriority = 'Critical' | 'High' | null;
/**
 * Every Status label that exists on Sprint Tasks. The reconciler only ever writes Done or Ready to
 * Start (from `PlanTask.done`); the middle three are execution state, written by the
 * monday-board-sync skill's corrector. See docs/features/monday-board-sync.md.
 */
export type TaskStatus =
  | 'Ready to Start'
  | 'In Progress'
  | 'Waiting for Review'
  | 'Pending Deploy'
  | 'Done';

export const EPIC_STATUS_INDEX: Record<EpicStatus, number> = {
  Planned: 0,
  'In Progress': 1,
  Shipped: 2,
  Cancelled: 3,
};
export const QUARTER_INDEX: Record<Quarter, number> = { Q1: 0, Q2: 1, Q3: 2, Q4: 3 };
export const TASK_TYPE_INDEX: Record<TaskType, number> = {
  Feature: 0,
  Bug: 1,
  Integration: 2,
  'n8n Workflow': 3,
  Chore: 5,
  Spike: 6,
  'PR Review': 7,
};
export const TASK_SPRINT_INDEX: Record<TaskSprint, number> = {
  // Indices are the board's own and are NOT sequential — S22 is 3 and S23 is 4, while S19-S21 run
  // 10-12. Read off the board settings_str 2026-08-19; never guess one.
  S17: 8, S18: 9, S19: 10, S20: 11, S21: 12, S22: 3, S23: 4, S24: 0, S25: 1, S26: 13, S27: 103, BL: 2,
};
/**
 * The live label TEXT for each sprint key. The board is structure-locked — the API cannot create a
 * Sprint label — so a pass must assert these still match `settings_str` before writing. There is no
 * Sprint 27 label yet: when Sprint 26 ends, someone adds it on the board by hand first.
 */
export const TASK_SPRINT_LABELS: Record<TaskSprint, string> = {
  S17: 'Sprint 17',
  S18: 'Sprint 18',
  S19: 'Sprint 19',
  S20: 'Sprint 20',
  S21: 'Sprint 21',
  S22: 'Sprint 22',
  S23: 'Sprint 23',
  S24: 'Sprint 24',
  S25: 'Sprint 25',
  S26: 'Sprint 26',
  S27: 'Sprint 27',
  BL: 'Backlog',
};
/**
 * The dates each sprint actually covers, read off the LIVE board group titles (verified 2026-08-13:
 * "Sprint 26 · Aug 4-15 · Backlog Pull", "Sprint 25 · Jul 21-Aug 1 · Backlog Pull", …). Inclusive,
 * `YYYY-MM-DD`.
 *
 * These exist so a Completed Date can be CHECKED against the sprint it is filed under. That check is
 * not decoration: on 2026-08-05 a single pass filed 46 rows spanning "Jul 29–Aug 5" into Sprint 26,
 * and 37 of them had finished inside Sprint 25's window — the board then claimed 94 SP of Sprint 25's
 * work as Sprint 26's for a week. A row whose date falls outside its sprint is mis-attributed by
 * definition, so `pass.mts`'s selfcheck refuses it.
 *
 * Sprints run Tuesday → Saturday, so the Sunday+Monday BETWEEN two sprints belong to no window at
 * all. Kane's ruling 2026-08-13: Sprint 26 is Aug 4-15 **only**, so gap-day work is filed under the
 * sprint that just closed. Backlog is deliberately absent — it is unscheduled, so no date can be
 * wrong for it.
 */
export const TASK_SPRINT_WINDOWS: Record<Exclude<TaskSprint, 'BL'>, { start: string; end: string }> = {
  S17: { start: '2026-03-31', end: '2026-04-11' },
  S18: { start: '2026-04-14', end: '2026-04-25' },
  S19: { start: '2026-04-28', end: '2026-05-09' },
  S20: { start: '2026-05-12', end: '2026-05-23' },
  S21: { start: '2026-05-26', end: '2026-06-06' },
  S22: { start: '2026-06-09', end: '2026-06-20' },
  S23: { start: '2026-06-23', end: '2026-07-04' },
  S24: { start: '2026-07-07', end: '2026-07-18' },
  S25: { start: '2026-07-21', end: '2026-08-01' },
  S26: { start: '2026-08-04', end: '2026-08-15' },
  // Added 2026-08-19 from the live group title "Sprint 27 · Aug 18-Aug 29". Adding it re-bounds
  // S26's ATTRIBUTION to Aug 4-17, which is what finally gives Aug 16-17 a sprint to belong to.
  S27: { start: '2026-08-18', end: '2026-08-29' },
};

/**
 * The dates a sprint will ACCEPT a Completed Date for — its scheduled window plus the gap days that
 * follow it, so that every date maps to exactly one sprint and none falls through.
 *
 * A CLOSED sprint absorbs its trailing Sun+Mon, because work finishing in the gap is that sprint's
 * spillover and nothing else has started yet. The LIVE sprint does not: its own gap has not happened,
 * there is no successor to bound it, and Kane's ruling is that Sprint 26 is Aug 4-15 **only**. So the
 * end is the day before the next sprint starts when there is a next sprint, and the sprint's own end
 * when there is not — which means adding Sprint 27 later extends Sprint 26 by its gap automatically,
 * the same treatment every earlier sprint got, rather than leaving Aug 16-17 homeless.
 *
 * Start is never widened: the gap belongs to the sprint that CLOSED, not the one about to open.
 */
export function taskSprintAttribution(sprint: Exclude<TaskSprint, 'BL'>): { start: string; end: string } {
  const self = TASK_SPRINT_WINDOWS[sprint];
  const later = Object.values(TASK_SPRINT_WINDOWS)
    .map((w) => w.start)
    .filter((start) => start > self.start)
    .sort();
  if (!later.length) return { start: self.start, end: self.end };
  const nextStart = new Date(`${later[0]}T00:00:00Z`);
  nextStart.setUTCDate(nextStart.getUTCDate() - 1);
  return { start: self.start, end: nextStart.toISOString().slice(0, 10) };
}
export const TASK_PRIORITY_INDEX: Record<Exclude<TaskPriority, null>, number> = {
  Critical: 0,
  High: 1,
};
export const TASK_STATUS_INDEX: Record<TaskStatus, number> = {
  'Ready to Start': 0,
  'In Progress': 1,
  'Waiting for Review': 2,
  'Pending Deploy': 3,
  Done: 4,
};
export const TASK_STATUS_DONE = TASK_STATUS_INDEX.Done;
export const TASK_STATUS_READY = TASK_STATUS_INDEX['Ready to Start'];

export interface PlanEpic {
  code: string; // "HRIS-17"
  title: string;
  /** Rollup Epic SP (sum of Fibonacci-scored sub-features — board convention). */
  sp: number;
  quarter: Quarter;
  /** Initial status — applied only when the epic is CREATED, never on update. */
  status: EpicStatus;
}

export interface PlanTask {
  epic: string; // parent epic code
  name: string; // without the "[HRIS] " prefix (added at sync time)
  type: TaskType;
  /**
   * Fibonacci. **Over** 8 is an epic, so 8 is a legal task score (the SP auditor's company rule —
   * on a Fibonacci scale the next step up is 13, so "over 8" and ">= 13" are the same rule).
   */
  sp: number;
  /**
   * Shipped AND proven. `true` makes the reconciler write Done plus an Actual SP; `false` writes
   * Ready to Start and no Actual SP. There is deliberately no way to express Pending Deploy or
   * Waiting for Review here — those are execution state, written by the monday-board-sync skill's
   * corrector, which is why an unproven row can never carry an invented Actual SP.
   * Applied only when the task is CREATED, never on update.
   */
  done: boolean;
  sprint: TaskSprint;
  priority?: TaskPriority;
  /**
   * The BOARD owns this row's group; the reconciler must never move it.
   *
   * A row's group and its Sprint label are normally the same fact stated twice, so `sync.ts`
   * reconciles the group to the label. That is wrong for a row a human has deliberately parked in a
   * triage group that has no Sprint label at all — "For Re-scoping" (`group_mm65rmf9`) is one, and
   * on 2026-08-19 three rows sat there while their labels still read Sprint 25 / Backlog / Backlog.
   * Without this flag the next reconcile would have silently dragged all three back out and erased
   * the triage. The LABEL stays reconciler-owned; only the move is suppressed. Kane's call 2026-08-19.
   *
   * RELEASED the same day, on all three rows, by the Sprint 27 pull — Kane scheduled them, so they
   * belong in the sprint group, not in triage. **No row sets this today.** The capability is kept
   * rather than deleted for one reason: "For Re-scoping" still exists on the board, so the next row
   * a human drags there needs the same protection, and `sync.ts` still reports `tasksGroupPinned`
   * so a suppressed move is never invisible. Deleting the flag would re-open the hole in a week.
   */
  groupPinned?: boolean;
}

/** Board item name for an epic (code TAB title — matches the board convention). */
export const epicItemName = (e: PlanEpic) => `${e.code}\t${e.title}`;
/** Board item name for a task. */
export const taskItemName = (t: PlanTask | { name: string }) => `[HRIS] ${t.name}`;

// ─── Epics ────────────────────────────────────────────────────────────────────

export const PLAN_EPICS: PlanEpic[] = [
  // Core platform epics (Design & Specifications breakdown — rollup SP kept).
  { code: 'HRIS-01', title: 'Employee Onboarding & Data Management', sp: 101, quarter: 'Q2', status: 'Shipped' },
  { code: 'HRIS-01a', title: 'Employee Onboarding & Offboarding Automation', sp: 80, quarter: 'Q2', status: 'Shipped' },
  { code: 'HRIS-02a', title: 'Payroll Wizard', sp: 90, quarter: 'Q2', status: 'Shipped' },
  { code: 'HRIS-02b', title: 'PAB Calculator & Rate Management', sp: 84, quarter: 'Q3', status: 'In Progress' },
  { code: 'HRIS-03a', title: 'Payment Dispatch', sp: 42, quarter: 'Q3', status: 'In Progress' },
  { code: 'HRIS-03b', title: 'Paystub Dispatch', sp: 26, quarter: 'Q3', status: 'In Progress' },
  { code: 'HRIS-03c', title: 'Vendors & Orphanage Payments', sp: 71, quarter: 'Q3', status: 'In Progress' },
  { code: 'HRIS-04', title: 'Employee Dispute / Issue System', sp: 52, quarter: 'Q3', status: 'In Progress' },
  { code: 'HRIS-05', title: 'RBAC, Security & Access Control', sp: 75, quarter: 'Q3', status: 'In Progress' },
  { code: 'HRIS-06', title: 'KPI Calculator & Payment Catalog', sp: 76, quarter: 'Q2', status: 'Shipped' },
  { code: 'HRIS-07', title: 'MESA Integration', sp: 41, quarter: 'Q3', status: 'In Progress' },
  { code: 'HRIS-08', title: 'Bonus Engine', sp: 64, quarter: 'Q2', status: 'Shipped' },
  { code: 'HRIS-09', title: 'Employee Self-Service Portal', sp: 96, quarter: 'Q3', status: 'In Progress' },
  { code: 'HRIS-10', title: 'Manager & My Team', sp: 53, quarter: 'Q3', status: 'In Progress' },
  { code: 'HRIS-11', title: 'CEO / Executive Suite', sp: 89, quarter: 'Q3', status: 'In Progress' },
  { code: 'HRIS-12', title: 'HR Operations Suite', sp: 48, quarter: 'Q2', status: 'Shipped' },
  { code: 'HRIS-13', title: 'Real-time Collaboration & Presence', sp: 54, quarter: 'Q3', status: 'In Progress' },
  { code: 'HRIS-14', title: 'Integrations (Google Sheets / Workspace / Hubstaff)', sp: 63, quarter: 'Q2', status: 'Shipped' },
  { code: 'HRIS-15', title: 'Platform, Admin & Observability', sp: 75, quarter: 'Q3', status: 'Shipped' },
  { code: 'HRIS-16', title: 'QC / Quality Control', sp: 18, quarter: 'Q2', status: 'Shipped' },
  // Commit-derived epics (2026-07-24 audit — Epic SP = rollup of sub-features).
  { code: 'HRIS-17', title: 'Tickets & Support Board (Kanban)', sp: 20, quarter: 'Q3', status: 'Shipped' },
  { code: 'HRIS-18', title: 'Documents Center & E-Signing', sp: 20, quarter: 'Q3', status: 'Shipped' },
  { code: 'HRIS-19', title: 'Bank Preferred Governance & WIRES Lock', sp: 20, quarter: 'Q3', status: 'Shipped' },
  { code: 'HRIS-20', title: 'Payroll Readiness Dashboard', sp: 12, quarter: 'Q3', status: 'Shipped' },
  { code: 'HRIS-21', title: 'Payroll Notes & Adjustments Bridge', sp: 14, quarter: 'Q3', status: 'Shipped' },
  // DRIFT, adjudicated 2026-08-11: the board says `Cancelled`, this says `Shipped`, and the
  // reconciler writes epic Status at CREATE only — so the board wins until someone fixes it BY HAND.
  // The evidence says Shipped and the board is wrong: the live-API ingest runs every Sunday via
  // `/api/cron/sync-hubstaff-week` (docs/features/hubstaff-weekly-auto-sync.md, built Jul 25 2026)
  // and `NEXT_PUBLIC_HUBSTAFF_API_ENABLED` is "true" in production. What WAS cancelled on Jul 29 is
  // only the on-demand path — the wizard's "Sync from Hubstaff" button and the `api_sync` branch on
  // POST /api/hubstaff-hours — dropped because Hubstaff's 1000 req/hour cap made it unreliable. The
  // weekly cron is now the ONLY live-API ingest path, and it works. Leave this `Shipped`; the board
  // row costs 12 SP of SP Completed until Kane flips it (a board write needs his approval).
  { code: 'HRIS-22', title: 'Hubstaff Live API Integration', sp: 12, quarter: 'Q3', status: 'Shipped' },
  { code: 'HRIS-23', title: 'People Directory & Pay Governance', sp: 25, quarter: 'Q3', status: 'Shipped' },
  { code: 'HRIS-24', title: 'New Hire Checklist & Hiring Analytics', sp: 20, quarter: 'Q3', status: 'Shipped' },
  { code: 'HRIS-25', title: 'Self-Serve Bank Update (OTP)', sp: 11, quarter: 'Q3', status: 'Shipped' },
  { code: 'HRIS-26', title: 'Department Transfers v2', sp: 14, quarter: 'Q3', status: 'Shipped' },
  { code: 'HRIS-27', title: 'Contractor Portal & Invoicing', sp: 20, quarter: 'Q2', status: 'Shipped' },
  { code: 'HRIS-28', title: 'CEO “Penny” AI Assistant & Live KPIs', sp: 18, quarter: 'Q2', status: 'Shipped' },
  { code: 'HRIS-29', title: 'Applicant Screening Hub', sp: 10, quarter: 'Q3', status: 'Shipped' },
  { code: 'HRIS-30', title: 'HSL KPI 2026-07 Overhaul & Week-Model Cutover', sp: 19, quarter: 'Q3', status: 'Shipped' },
  { code: 'HRIS-31', title: 'S-WALL Social Wall & Announcements', sp: 11, quarter: 'Q2', status: 'Shipped' },
  { code: 'HRIS-32', title: 'Gifts & Milestones Tracker', sp: 12, quarter: 'Q2', status: 'Shipped' },
  // Sprint 26 reconciliation (2026-08-05 audit of Jul 29 – Aug 5, 171 commits).
  // Pay Cycle Reports rolls up to 13 SP — over the 8-point line, so it is an epic
  // with three sprint tasks rather than one oversized task.
  { code: 'HRIS-33', title: 'Pay Cycle Reports & Publication', sp: 13, quarter: 'Q3', status: 'Shipped' },
];

// ─── Sprint tasks ─────────────────────────────────────────────────────────────

export const PLAN_TASKS: PlanTask[] = [
  // Legacy backlog items (spec-derived, recreated 2026-07-24 as Done).
  { epic: 'HRIS-24', name: 'New Hire Checklist', type: 'Feature', sp: 5, done: true, sprint: 'S24' },
  { epic: 'HRIS-01a', name: 'Onboarding Gmail Surname', type: 'Feature', sp: 5, done: true, sprint: 'S22' },
  { epic: 'HRIS-01a', name: 'Onboarding Ip Assignment', type: 'Feature', sp: 5, done: true, sprint: 'S22' },
  { epic: 'HRIS-01a', name: 'Onboarding Pay Plans', type: 'Feature', sp: 5, done: true, sprint: 'S22' },
  { epic: 'HRIS-01a', name: 'Workspace Account Verify', type: 'Feature', sp: 3, done: true, sprint: 'S22' },
  { epic: 'HRIS-08', name: 'Bonus Calculator', type: 'Feature', sp: 5, done: true, sprint: 'S19' },
  { epic: 'HRIS-02a', name: 'Payroll Wizard Final Pay', type: 'Feature', sp: 5, done: true, sprint: 'S22' },
  { epic: 'HRIS-03a', name: 'Urgent Payments', type: 'Feature', sp: 5, done: true, sprint: 'S21' },
  { epic: 'HRIS-04', name: 'Time Adjustment Requests', type: 'Feature', sp: 5, done: true, sprint: 'S21' },
  { epic: 'HRIS-03c', name: 'Orphanage Dispute Flow', type: 'Feature', sp: 3, done: true, sprint: 'S19' },
  { epic: 'HRIS-05', name: 'Delete Authorization', type: 'Feature', sp: 3, done: true, sprint: 'S19' },
  { epic: 'HRIS-05', name: 'Rbac Feature Permissions', type: 'Feature', sp: 5, done: true, sprint: 'S20' },
  { epic: 'HRIS-05', name: 'Route Authorization', type: 'Feature', sp: 3, done: true, sprint: 'S23' },
  { epic: 'HRIS-07', name: 'Mesa', type: 'Feature', sp: 5, done: true, sprint: 'S21' },
  // Commit-derived tasks (2026-07-24 audit).
  { epic: 'HRIS-01a', name: 'CallTools username capture + orientation webhook', type: 'Feature', sp: 5, done: true, sprint: 'S24' },
  { epic: 'HRIS-01a', name: 'Offboarding queue processor + notifications', type: 'Feature', sp: 5, done: true, sprint: 'S23' },
  { epic: 'HRIS-01a', name: 'Resignation requests flow', type: 'Feature', sp: 3, done: true, sprint: 'S23' },
  { epic: 'HRIS-01a', name: '“Temporary Pause” offboard reason (suspend-only)', type: 'Feature', sp: 2, done: true, sprint: 'S24' },
  { epic: 'HRIS-01a', name: "Offboarding weekly pulse card (Teal's request)", type: 'Feature', sp: 2, done: true, sprint: 'S24' },
  { epic: 'HRIS-01a', name: 'Onboarding name split → structured first/last/extension columns', type: 'Feature', sp: 3, done: true, sprint: 'S24' },
  { epic: 'HRIS-01a', name: 'Re-hires landing invisible (offboard-row reuse) — fixes', type: 'Bug', sp: 3, done: true, sprint: 'S24' },
  { epic: 'HRIS-01a', name: 'clearOffboarded re-activation collision guard', type: 'Bug', sp: 2, done: true, sprint: 'S25' },
  { epic: 'HRIS-02a', name: 'Paystub freshness: staged ⊕ final-pay snapshot merge + mark-paid reconcile', type: 'Bug', sp: 5, done: true, sprint: 'S25' },
  { epic: 'HRIS-02a', name: 'MESA deduction integrity (no ₱100 for opt-outs + ledger-gap suppression at 7 sites)', type: 'Bug', sp: 3, done: true, sprint: 'S25' },
  { epic: 'HRIS-02a', name: 'Payroll performance indexes + anti-lag pass', type: 'Chore', sp: 3, done: true, sprint: 'S20' },
  { epic: 'HRIS-02a', name: 'USD⇄PHP conversion with cycle value-lock', type: 'Feature', sp: 3, done: true, sprint: 'S17' },
  { epic: 'HRIS-02b', name: 'PAB payout-week gate + neutral mid-period Additions pill', type: 'Feature', sp: 3, done: true, sprint: 'S24' },
  { epic: 'HRIS-02b', name: 'US holidays PAB forgiveness seed', type: 'Feature', sp: 2, done: true, sprint: 'S20' },
  { epic: 'HRIS-02b', name: 'Remove employee-facing PAB disputes (keep manager calendar + API)', type: 'Feature', sp: 2, done: true, sprint: 'S24' },
  // Pulled S25 → Sprint 27 on 2026-08-19. Still open, and its root cause moved under it: 273319a
  // (2026-08-18) REMOVED the snap-to-Sunday that c39fad3 introduced, so the arrears figure needs
  // re-deriving against the current proration rule before anyone pays against it.
  { epic: 'HRIS-02b', name: 'HSL rate-history stale underpay — arrears remediation (≈₱1.06M, 121 under / 10 over)', type: 'Spike', sp: 5, done: true, sprint: 'S27', priority: 'High' },
  { epic: 'HRIS-02b', name: 'Rate change history + manager rate views', type: 'Feature', sp: 3, done: true, sprint: 'S20' },
  { epic: 'HRIS-03a', name: 'Mark Paid bank-details override (pencil mode + endpoint + notification)', type: 'Feature', sp: 5, done: true, sprint: 'S25' },
  { epic: 'HRIS-03a', name: 'Processor filter cards redesign + real logos; focus-mode removed', type: 'Feature', sp: 3, done: true, sprint: 'S25' },
  { epic: 'HRIS-03a', name: 'One-off Urgent payments (People → Pay → Urgent queue)', type: 'Feature', sp: 5, done: true, sprint: 'S25' },
  { epic: 'HRIS-03a', name: 'Dispatch undo + Done queue', type: 'Feature', sp: 3, done: true, sprint: 'S21' },
  { epic: 'HRIS-03b', name: 'Employee paystub modal + Pay Stubs profile tab + PDF/XLSX export', type: 'Feature', sp: 5, done: true, sprint: 'S24' },
  { epic: 'HRIS-03b', name: 'Salary “Ready to View” + “Paid” notifications', type: 'Feature', sp: 3, done: true, sprint: 'S24' },
  { epic: 'HRIS-03c', name: 'Orphanage vendors + vendor invoices', type: 'Feature', sp: 5, done: true, sprint: 'S24' },
  { epic: 'HRIS-03c', name: 'Orphanage worker payments', type: 'Feature', sp: 3, done: true, sprint: 'S23' },
  { epic: 'HRIS-03c', name: 'Orphanage budget requests + accounting approval', type: 'Feature', sp: 5, done: true, sprint: 'S19' },
  { epic: 'HRIS-04', name: 'Time-adjustment segments: require missed time-in/out (additive)', type: 'Feature', sp: 3, done: true, sprint: 'S24' },
  { epic: 'HRIS-05', name: 'Per-tab edit permission enforced on all write APIs (block view-only writes)', type: 'Feature', sp: 5, done: true, sprint: 'S22' },
  { epic: 'HRIS-05', name: 'Dashboard-only roles + per-tab ABAC + auto-provision on assign', type: 'Feature', sp: 5, done: true, sprint: 'S19' },
  { epic: 'HRIS-05', name: 'Session invalidation watcher + force logout + live reset', type: 'Feature', sp: 3, done: true, sprint: 'S22' },
  { epic: 'HRIS-05', name: 'Tickets gated by dedicated role (+ cleanup migration)', type: 'Feature', sp: 2, done: true, sprint: 'S24' },
  { epic: 'HRIS-06', name: 'Payment-catalog pay structures + PDF/CSV reports', type: 'Feature', sp: 5, done: true, sprint: 'S22' },
  { epic: 'HRIS-06', name: 'Employee KPI results view', type: 'Feature', sp: 3, done: true, sprint: 'S22' },
  { epic: 'HRIS-06', name: 'Medical Records: RFC as manual ₱ amount (not ×250)', type: 'Feature', sp: 2, done: true, sprint: 'S24' },
  { epic: 'HRIS-06', name: 'Bonus Catalog CRUD + formula engine — split of legacy 8-pt item', type: 'Feature', sp: 5, done: true, sprint: 'S22' },
  { epic: 'HRIS-06', name: 'Applied-bonus tracking + cadence + manager history — split', type: 'Feature', sp: 3, done: true, sprint: 'S24' },
  { epic: 'HRIS-07', name: 'MESA ledger DDL + backfill + membership preload', type: 'Feature', sp: 5, done: true, sprint: 'S24' },
  { epic: 'HRIS-07', name: 'MESA per-stint accounts (YY-MM-##### numbering)', type: 'Feature', sp: 3, done: true, sprint: 'S24' },
  { epic: 'HRIS-07', name: 'MESA notes + Non Members Opt In/Out bridge', type: 'Feature', sp: 3, done: true, sprint: 'S24' },
  { epic: 'HRIS-07', name: 'Weekly 100+300 ledger deposits on upload + opt-in date derivation', type: 'Feature', sp: 3, done: true, sprint: 'S24' },
  { epic: 'HRIS-09', name: 'Skill sets + Employee Team roster', type: 'Feature', sp: 5, done: true, sprint: 'S21' },
  { epic: 'HRIS-09', name: 'FPU enrollment flow', type: 'Feature', sp: 3, done: true, sprint: 'S20' },
  { epic: 'HRIS-09', name: 'Medals & commendations', type: 'Feature', sp: 3, done: true, sprint: 'S20' },
  { epic: 'HRIS-09', name: 'Profile name-parts editor (First/Middle/Last/Ext/Nickname)', type: 'Feature', sp: 3, done: true, sprint: 'S24' },
  { epic: 'HRIS-09', name: 'Profile completion card + payout fields', type: 'Feature', sp: 3, done: true, sprint: 'S20' },
  { epic: 'HRIS-12', name: 'HR + Admin Global Master List editors (incl. People-tab GML edit)', type: 'Feature', sp: 5, done: true, sprint: 'S24' },
  { epic: 'HRIS-13', name: 'Cobrowse chat window + providers', type: 'Feature', sp: 5, done: true, sprint: 'S24' },
  { epic: 'HRIS-13', name: 'Observe-mode mirror: driver-opened modals invisible — rrweb style-rules fix', type: 'Bug', sp: 3, done: true, sprint: 'S25' },
  { epic: 'HRIS-13', name: 'Presence heartbeat + last-seen', type: 'Feature', sp: 3, done: true, sprint: 'S24' },
  { epic: 'HRIS-13', name: 'HR collab layer (shared cursors on checklist)', type: 'Feature', sp: 3, done: true, sprint: 'S23' },
  // Pulled Backlog → Sprint 27 on 2026-08-19 (Kane: "any backlog or any future task that we may be
  // possible to achieve"). Scope has SHRUNK under it since it was written — 28cb65d retired the
  // Google Sheet as an offboarding source outright — so the sprint should re-scope it, not just
  // schedule it. Stays `done: false`: the row carried a phantom Actual SP 5 while reading Ready to
  // Start, which the corrector clears in this same pass.
  { epic: 'HRIS-14', name: 'Google Sheet sync crons (master / rates / HSL / offboarded) — split of legacy Csv Imports', type: 'Integration', sp: 5, done: false, sprint: 'S27' },
  { epic: 'HRIS-14', name: 'CSV imports admin tab — split of legacy Csv Imports', type: 'Feature', sp: 3, done: true, sprint: 'S19' },
  { epic: 'HRIS-14', name: 'Master-list sync race + orphaned-upload guard', type: 'Bug', sp: 3, done: true, sprint: 'S24' },
  { epic: 'HRIS-14', name: 'Webhooks admin + bank-info-missing red-alarm notify email', type: 'Integration', sp: 2, done: true, sprint: 'S25' },
  { epic: 'HRIS-15', name: 'Dashboard-switch performance Tier 0 + PAB ?all_files=1 batch', type: 'Chore', sp: 5, done: true, sprint: 'S25' },
  { epic: 'HRIS-15', name: 'Collapsible sidebar shell redesign', type: 'Feature', sp: 3, done: true, sprint: 'S23' },
  { epic: 'HRIS-15', name: 'System diagnostics + API-500 hardening', type: 'Chore', sp: 3, done: true, sprint: 'S19' },
  { epic: 'HRIS-15', name: 'Mobile responsiveness pass (all dashboards)', type: 'Chore', sp: 5, done: true, sprint: 'S19' },
  { epic: 'HRIS-15', name: 'Admin search bar + pages registry', type: 'Feature', sp: 3, done: true, sprint: 'S22' },
  { epic: 'HRIS-15', name: 'Impersonation (view-as) banner + auth', type: 'Feature', sp: 3, done: true, sprint: 'S23' },
  // ── Pulled into Sprint 27 on 2026-08-19 ────────────────────────────────────────────────────────
  // Both were open work stranded in Sprint 25, a sprint that closed 2026-08-01. Carrying unfinished
  // work forward to the live sprint is the ordinary rollover; nothing about either row is re-judged
  // and neither gets a Completed Date, because neither is shipped.
  //
  // The migrations row ALSO loses `groupPinned` — see the field's own doc for why that pin existed
  // and why Kane released it the same day he created it.
  // done:true 2026-08-20. The "(12+ pending SQL files)" in the title was FOLKLORE — measured with
  // scripts/audit-pending-migrations.mts it was ONE (`restore_active_employees_definer`), plus three
  // notification-type CHECK rows PostgREST cannot read. All are now applied and all ten n8n workflows
  // are settled on Kane's confirmation. The title is deliberately NOT corrected: item names are set
  // at CREATE only, so renaming would orphan this row and mint a duplicate. The correction lives in
  // the row's evidence update instead.
  { epic: 'HRIS-15', name: 'Run outstanding Supabase migrations + re-import n8n workflows (12+ pending SQL files)', type: 'Chore', sp: 3, done: true, sprint: 'S27', priority: 'Critical' },
  // ── Sprint 27, found by MEASUREMENT on 2026-08-20 while closing the row above ─────────────────
  // None of these three was on the board. They exist because the migrations audit turned over rocks:
  // two shipped, "Done" features had never once worked, and the reason nobody noticed is a logging
  // choice. Kane approved adding them 2026-08-20 ("go").
  { epic: 'HRIS-06', name: 'KPI scored notification fires on months-old weeks — floor it to the current period', type: 'Bug', sp: 2, done: true, sprint: 'S27', priority: 'High' },
  { epic: 'HRIS-15', name: 'Notification insert failures are swallowed into console.warn — make them observable', type: 'Chore', sp: 3, done: true, sprint: 'S27', priority: 'High' },
  { epic: 'HRIS-02b', name: 'PAB exclusions leave no audit trail while PAB disputes are fully audited', type: 'Feature', sp: 2, done: true, sprint: 'S27', priority: 'High' },
  { epic: 'HRIS-19', name: 'Legacy rates-sheet cell can route null-preferred → hurupay: decision + guard', type: 'Spike', sp: 2, done: false, sprint: 'S27', priority: 'High' },
  { epic: 'HRIS-24', name: 'Referred-by column + Referrals week section (email-tier matching)', type: 'Feature', sp: 3, done: true, sprint: 'S24' },
  // ── Sprint 26 reconciliation — shipped Jul 29 – Aug 5 2026 ─────────────────
  // Grouped from 171 commits by feature, not by commit. SP scored against the
  // live Sprint 26 items (1–5, avg 3.49); anything that rolled up to 8+ became
  // an epic instead (HRIS-33). Commit SHAs live in each board item's update.
  { epic: 'HRIS-01a', name: 'Manager Suspend + Reactivation (temp-pause) riding the offboarding-deactivate flow', type: 'Feature', sp: 5, done: true, sprint: 'S26' },
  { epic: 'HRIS-02a', name: 'Per-cycle FX zero placeholders — dispatch hard-blocked until both legs are set', type: 'Feature', sp: 5, done: true, sprint: 'S26' },
  { epic: 'HRIS-02a', name: 'Rate snapshots toggle on Dispatch — floating People/Catalog cards', type: 'Feature', sp: 2, done: true, sprint: 'S25' },
  { epic: 'HRIS-02b', name: 'Mid-week rate-change proration on the statement — catalog-consistent history, both engines', type: 'Feature', sp: 5, done: true, sprint: 'S25' },
  { epic: 'HRIS-02b', name: 'Rate-history effective_from snapped to the pay-week start', type: 'Bug', sp: 3, done: true, sprint: 'S26' },
  { epic: 'HRIS-02b', name: 'HSL OT-rate arrears audit + remediation — weekend premium sat in the OT column', type: 'Chore', sp: 5, done: true, sprint: 'S26' },
  { epic: 'HRIS-02b', name: 'PAB exclusion → employee notification (route + DDL + wizard toggle)', type: 'Feature', sp: 3, done: true, sprint: 'S25' },
  { epic: 'HRIS-03a', name: 'Sub-₱7k PHP wires reroute to Wise + Under ₱7k dispatch filter chip', type: 'Feature', sp: 3, done: true, sprint: 'S25' },
  { epic: 'HRIS-03a', name: 'Urgent payments: week-long bucket (Pending/Paid/Not Paid) + Undo + n8n alert', type: 'Feature', sp: 5, done: true, sprint: 'S25' },
  { epic: 'HRIS-03a', name: 'Colombian payees show/copy their native COP amount', type: 'Feature', sp: 3, done: true, sprint: 'S25' },
  { epic: 'HRIS-03a', name: 'Payment cycle 100% paid → completion email to Accounting', type: 'Integration', sp: 2, done: true, sprint: 'S25' },
  { epic: 'HRIS-03a', name: 'Staged-only dispatch placement guard', type: 'Bug', sp: 3, done: true, sprint: 'S25' },
  { epic: 'HRIS-03b', name: 'HSL Weekend Hours itemized under Earnings + transfer-week day scoping', type: 'Feature', sp: 5, done: true, sprint: 'S25' },
  { epic: 'HRIS-03b', name: 'Accounting-only dispatch log panel on the Pay Stub modal + Excluded/Paid Records rework', type: 'Feature', sp: 5, done: true, sprint: 'S25' },
  { epic: 'HRIS-03b', name: 'Tech bonus on recovered weeks + one paystub row per week', type: 'Bug', sp: 3, done: true, sprint: 'S25' },
  { epic: 'HRIS-03b', name: 'Paystub rate-consistency guard — Payment Catalog is the source of truth', type: 'Bug', sp: 3, done: true, sprint: 'S25' },
  { epic: 'HRIS-05', name: 'security_invoker on active_employees blanked the wizard dept source — restore + verifier', type: 'Bug', sp: 3, done: true, sprint: 'S25' },
  { epic: 'HRIS-05', name: 'Roster bulk check hit an RLS-blocked view — direct GML read via /api/roster/gml-status', type: 'Bug', sp: 3, done: true, sprint: 'S25' },
  { epic: 'HRIS-06', name: 'Payment Catalog Overview → Summary pay-mix dashboard', type: 'Feature', sp: 5, done: true, sprint: 'S25' },
  { epic: 'HRIS-06', name: 'Payment Catalog Department cards + Search hero dock-to-top glide', type: 'Feature', sp: 2, done: true, sprint: 'S25' },
  { epic: 'HRIS-06', name: "Shared master-list email merged two people's KPI bonuses", type: 'Bug', sp: 3, done: true, sprint: 'S25' },
  { epic: 'HRIS-06', name: '“Set rate” updates the existing pay structure instead of dying on a duplicate key', type: 'Bug', sp: 2, done: true, sprint: 'S26' },
  { epic: 'HRIS-07', name: 'MESA disbursement receipts — Receipt column, gallery, Approved/Paid from dispatch', type: 'Feature', sp: 3, done: true, sprint: 'S25' },
  { epic: 'HRIS-08', name: 'Custom System Bonuses in COP/USD (PAB & Tech currency variants)', type: 'Feature', sp: 5, done: true, sprint: 'S25' },
  { epic: 'HRIS-09', name: 'Employee Pay snapshot grid + one-page Pay Summary PDF', type: 'Feature', sp: 3, done: true, sprint: 'S25' },
  { epic: 'HRIS-10', name: 'My Team: MESA-style table + card parity with row actions', type: 'Feature', sp: 3, done: true, sprint: 'S26' },
  { epic: 'HRIS-11', name: 'Overview Total Payout hero counts the full pay run (payout extras)', type: 'Feature', sp: 3, done: true, sprint: 'S25' },
  { epic: 'HRIS-13', name: 'Collab on/off as an admin system setting', type: 'Feature', sp: 3, done: true, sprint: 'S25' },
  { epic: 'HRIS-13', name: 'Observe mirror portaled to the document body so the sidebar cannot overlap it', type: 'Bug', sp: 1, done: true, sprint: 'S25' },
  { epic: 'HRIS-15', name: "Page every roster/pay read past PostgREST's silent 1000-row cap", type: 'Bug', sp: 3, done: true, sprint: 'S25' },
  { epic: 'HRIS-15', name: 'Webhooks admin: sample payloads for every configured slug', type: 'Feature', sp: 2, done: true, sprint: 'S25' },
  { epic: 'HRIS-18', name: 'HRIS generates the Certificate of Engagement — no upload', type: 'Feature', sp: 5, done: true, sprint: 'S25' },
  { epic: 'HRIS-18', name: 'Employee document preview panel', type: 'Feature', sp: 3, done: true, sprint: 'S25' },
  { epic: 'HRIS-20', name: 'Wizard Setup readiness checklist as its own first tab + week-scoped roster + step-1 CSV modal', type: 'Feature', sp: 5, done: true, sprint: 'S25' },
  { epic: 'HRIS-20', name: 'Bank Info per-week Temporary Exemption', type: 'Feature', sp: 3, done: true, sprint: 'S26' },
  { epic: 'HRIS-20', name: 'Payroll Notes FAB readiness ring + Readiness leads the tab strip', type: 'Feature', sp: 3, done: true, sprint: 'S25' },
  { epic: 'HRIS-21', name: 'Payroll Notes Offboarded tab — final-pay rate/bank for leavers', type: 'Feature', sp: 5, done: true, sprint: 'S26' },
  { epic: 'HRIS-21', name: 'Payroll Notes tab cache — board, readiness + rates no longer re-pulled', type: 'Chore', sp: 2, done: true, sprint: 'S25' },
  { epic: 'HRIS-24', name: 'Checklist lock webhook sanitizes emails so one bad cell cannot strand the week', type: 'Bug', sp: 2, done: true, sprint: 'S25' },
  { epic: 'HRIS-26', name: 'HR Transfers tab shows the full transfer trail again', type: 'Bug', sp: 2, done: true, sprint: 'S25' },
  { epic: 'HRIS-27', name: 'Contractor invoices period-scoped to the pay cycle; dispatch rows open the invoice', type: 'Feature', sp: 5, done: true, sprint: 'S25' },
  { epic: 'HRIS-28', name: 'Penny AI: full audit-log visibility (timeline, notes history, action catalogue)', type: 'Feature', sp: 3, done: true, sprint: 'S25' },
  { epic: 'HRIS-30', name: 'Collections TL + Simple Texting removed from the HSL schema + DB purge', type: 'Feature', sp: 2, done: true, sprint: 'S26' },
  { epic: 'HRIS-33', name: 'Pay-cycle report snapshot model + publish/list/unpublish API', type: 'Feature', sp: 5, done: true, sprint: 'S25' },
  { epic: 'HRIS-33', name: 'Reports tab: list, detail view + CSV/XLSX/PDF export', type: 'Feature', sp: 5, done: true, sprint: 'S25' },
  { epic: 'HRIS-33', name: 'Publish-gate + unpublish-audit hardening', type: 'Bug', sp: 3, done: true, sprint: 'S25' },
  // ── Sprint 26 second pass — committed 5a6c52f..488cf44 (Aug 5–11 2026, 78 commits) ──────────
  // Clustered by FILE OVERLAP, never by commit message: 488cf44 "HSL Weekend Hours Fix" contains no
  // code at all, 02dc5aa "Massiv Update" carried two unrelated features, a7ecd4c "Callback" three,
  // and 5eb398a's weekend-OT pricing was reversed by e0028b8 — so one row describes the CURRENT rule.
  //
  // done: true on the seven Kane confirmed working in production on 2026-08-11. The five below with
  // done:false are NOT a matter of confirmation — each has a named external step nobody has run
  // (n8n import, webhooks seed, cycle re-lock, zero `hsl:*` rate rows), so they sit in the Backlog
  // and the skill's corrector marks them Pending Deploy. Commit SHAs live in each item's update.
  { epic: 'HRIS-02a', name: 'Wizard Validation step shows the full per-person calculation with red and amber flags', type: 'Feature', sp: 5, done: true, sprint: 'S26' },
  { epic: 'HRIS-03a', name: 'Close Pay Cycle from the Stop dialog — permanent close-out record naming who was left unpaid', type: 'Feature', sp: 5, done: true, sprint: 'S26' },
  { epic: 'HRIS-08', name: 'Configurable Tech Bonus payout week (System Bonus modal, Sun–Sat) wired to every gate + KPI bonuses in the employee Estimated Take-Home', type: 'Feature', sp: 5, done: true, sprint: 'S26' },
  { epic: 'HRIS-02a', name: "Wizard week selector replays that week's own bonuses, monthly HSL period and readiness instead of today's", type: 'Bug', sp: 5, done: true, sprint: 'S26' },
  { epic: 'HRIS-19', name: 'Bank rail parity: People, wizard preview, Urgent cards and the bank-update form resolve the rail Payment Dispatch actually pays on; USD bucket retired', type: 'Bug', sp: 5, done: true, sprint: 'S26' },
  { epic: 'HRIS-05', name: 'Disbursement report, contractor and app-settings API routes gated by matching role — 2026-08-10 SECURITY_AUDIT re-verify', type: 'Bug', sp: 5, done: true, sprint: 'S26' },
  { epic: 'HRIS-06', name: 'Eleven departments permanently retired from the KPI Calculator + Callback accepts external members', type: 'Feature', sp: 3, done: true, sprint: 'S26' },
  // These three were filed in the Backlog because each was blocked on the same un-run external step
  // — the n8n paystub import. That import landed 2026-08-12 and all three went Done the same day, but
  // nobody moved them out of the Backlog, so 21 SP of Sprint 26's work sat under "unscheduled" for two
  // days. **Backlog is not a status.** A Done row belongs in the sprint its work finished in, and all
  // three finished inside Sprint 26's window (Aug 4-15) — which is the exact mirror of the 2026-08-13
  // re-attribution, where 37 rows sat in a sprint their work had NOT finished in. Re-filed to S26 on
  // Kane's call 2026-08-14. Their Completed Date (2026-08-12, the day the import made them provable)
  // is already on the board and already inside the window, so this is a group+label move only.
  //
  // 8, not 5 (Kane 2026-08-11): three pay engines repriced in lockstep + a new
  // payload contract (hogan_sheet) consumed by five render surfaces + four
  // validators. Scored with this pass's other multi-subsystem 8s, not with the
  // single-surface HSL 5s. Still a task — over 8 is the epic line.
  { epic: 'HRIS-02b', name: 'HSL pay = the Hogan sheet column AN verbatim — hogan-week-pay becomes the single rate authority, reversing the 2026-08-07 weekend-OT removal', type: 'Feature', sp: 8, done: true, sprint: 'S26' },
  { epic: 'HRIS-03b', name: 'One merged Weekend Hours line + dated rate-change disclosure on statement, email and export', type: 'Feature', sp: 5, done: true, sprint: 'S26' },
  { epic: 'HRIS-03b', name: 'Paystub email HTML rendered in-app (n8n Gmail becomes a pipe) + System Bonus snapshot columns on payment_dispatches', type: 'Feature', sp: 8, done: true, sprint: 'S26' },
  // Still blocked on an un-run external step — Backlog, corrected to Pending Deploy by the skill.
  // Deliberately NOT moved on 2026-08-14: Kane's instruction was Done-only, and neither of these is
  // Done. The HSL row's recorded blocker (zero `hsl:*` rate rows) may have cleared when 210b9ad seeded
  // the placement-only base rates at 225 / 337.50 — that is a status judgement for Kane, and a row is
  // never promoted just because its blocker LOOKS stale.
  //
  // MOVED 2026-08-19, Backlog → Sprint 27, and unpinned out of "For Re-scoping". Both are **Pending
  // Deploy**, not Ready to Start: the code is on `origin/main` and nobody has clicked through it in
  // prod. Scheduling a row does NOT promote it — the honesty gate is unchanged and each keeps its
  // blocker. 8 SP is a legal task score (the next Fibonacci step is 13), so neither needs decomposing.
  { epic: 'HRIS-01a', name: 'Offboarding is delete-only: suspend is its own path, suspended-person offboards escalate to delete, and leavers get a correct final check', type: 'Feature', sp: 8, done: true, sprint: 'S27' },
  { epic: 'HRIS-06', name: 'One HSL department + required sub-department that sets the base rate, wired through the Payment Catalog', type: 'Feature', sp: 8, done: true, sprint: 'S27' },
  // ── Sprint 26 third pass — committed 0cda107..3d74e09 (Aug 12 2026) ──────────────────────────
  // done:true 2026-08-12, and this row is the clearest case yet for why the honesty gate exists: it
  // sat at In Progress (unpushed), then Pending Deploy (pushed, migration un-run) before earning
  // this. Kane applied add_middle_name_to_onboarding.sql and MEASUREMENT — not his claim — closed
  // it: a read-only PostgREST probe returned both middle_name columns present, which also proves
  // the PostgREST schema cache reloaded (a stale cache would keep rejecting the column with
  // PGRST204 long after the DDL succeeded). With the columns live the optional-column retry no
  // longer strips the key, so the middle name persists. Basis for Done is Kane's sign-off ON TOP OF
  // that measurement; the form itself was NOT separately exercised, and the row's item update says
  // so in those words rather than implying an end-to-end test nobody ran.
  // 3 SP against the Sprint 26 band (1–5, avg ~3.5): narrower than the 3-SP name-split row it sits
  // beside, plus a dialog, a migration + apply script and a feature doc.
  { epic: 'HRIS-01a', name: 'Onboarding paperwork: Middle name box + one-time first/last name-order check', type: 'Bug', sp: 3, done: true, sprint: 'S26' },
  // ── Sprint 26 fourth pass — committed 5950b2e (Aug 11 2026) ─────────────────────────────────
  // done:true on Kane's prod confirmation 2026-08-12 ("Confirmed payroll wizard published" — the
  // Amount Source column reading "Payroll Wizard (published)"), plus his sign-off to close the row.
  // On origin/main (verified by rev-list membership AND by reading the module, the doc section and
  // the sync channel out of origin/main's tree) with no migration and no n8n import, so there was
  // never an external step between it and live. What the Done rests on — including which half was
  // eyeballed and which was accepted on sign-off — is recorded verbatim in the row's item update.
  // 5 SP against the Sprint 26 band (1–5, avg ~3.5): the peer of the 5-SP "Paystub freshness"
  // row, whose engine this one extracts the shared precedence OUT of, and broader than the 3-SP
  // "Staged-only dispatch placement guard" / "Paystub rate-consistency guard" rows beside it —
  // 21 files, a new pure module with 29 tests, five QueueRow construction sites, a new API read
  // mode, a Realtime channel + fallback poll, and a live verifier. Not 8: single screen, no new
  // subsystem.
  { epic: 'HRIS-03a', name: 'Payment Dispatch prices every row from the Payroll Wizard — one shared snapshot-or-lock precedence — and syncs live across open screens', type: 'Bug', sp: 5, done: true, sprint: 'S26' },
  // ── Sprint 26 fifth pass — committed 6b8921f (Aug 12 2026) ──────────────────────────────────
  // done:true on Kane's prod confirmation 2026-08-12: he opened Documents → Actions → View in
  // production and the signed PDF rendered. That is the ONE thing typechecking could not prove —
  // the pane re-fetches the signed URL and re-wraps the bytes as a blob: URL, which only works if
  // Supabase Storage answers the browser fetch with permissive CORS — so his click retires the
  // sole blocker this row ever carried. It was already on origin/main (Kane pushed as ce83a73) and
  // the 4-file diff carries no .sql, no apply-*.mjs and no workflow json, so no external step ever
  // stood between it and live.
  // 3 SP against the Sprint 26 band (1–5, avg ~3.5): the peer of the 3-SP "My Team: MESA-style
  // table + card parity" row — the same restyle-onto-the-MESA-pattern job — plus a read-only modal
  // over fields the row already carries. Not 5: one component, zero new endpoints, no new query,
  // no migration, no data path touched. The 5-SP rows beside it each added a fetch or a tab.
  { epic: 'HRIS-18', name: 'Documents queue rebuilt on the MESA anatomy — KPI cards, full-width table and a View modal that renders the signed copy inline', type: 'Feature', sp: 3, done: true, sprint: 'S26' },
  // ── Sprint 26 sixth pass — the external step itself, as a row (Kane approved 2026-08-12) ─────
  // Its own row rather than the HRIS-15 "Run outstanding Supabase migrations + re-import n8n
  // workflows" chore: that one is a catch-all sitting in S25 whose premise is largely folklore
  // (21 of 25 "pending" migrations were already applied), and nobody would mark it Done for
  // importing one specific workflow. This row can be marked Done the moment the import lands.
  // done:true from 2026-08-12 — Kane confirmed the new workflow is LIVE. It travelled
  // Ready to Start → Done within the day, which is the honesty gate working, not a change of mind:
  // it was never Pending Deploy, because the row WAS the external step rather than code waiting on
  // one. It had been the blocker on three scored rows (8 + 5 + 8 = 21 SP): the column-AN rule, the
  // merged Weekend Hours line, and paystub email rendered in-app — all three are now unblocked.
  // 2 SP against the Sprint 26 band (1–5, avg ~3.5): an import plus verifying the Gmail node
  // bindings, the three response field names the HRIS parses, and one test send. Not 1 — the
  // summary node carries two traps that were both live bugs (.isExecuted guards, skipped items
  // counting into failed), so this is a verify job, not a file upload.
  { epic: 'HRIS-03b', name: 'Import paystub-dispatch.workflow.json into live n8n so emailed statements match the app', type: 'n8n Workflow', sp: 2, done: true, sprint: 'S26', priority: 'High' },
  // ══ Sprint 26 / Sprint 27 backfill — pass 5, 2026-08-20 (range 9fe6504c..HEAD, 83 commits) ══════
  // Kane 2026-08-20: "for the past week or so we have undocumented features". This block is that
  // week, clustered by FILE OVERLAP rather than message — four commit messages in this range are
  // actively misleading ("Push" carried the whole notification-chime feature, "ss" carried an
  // unapplied payroll fix script, "s"/"Push" carried only settings + backups).
  //
  // ATTRIBUTION: S26 accepts Aug 4–17 (it absorbs the Aug 16–17 gap days), S27 accepts Aug 18–29.
  // Every date below is the commit date of the row's LAST sha, which selfcheck() re-derives from git.
  //
  // done:true on all but three rows rests on ONE stated basis: Kane confirmed 2026-08-20, asked
  // explicitly, that he has used all of them in production. The three exceptions are not a matter of
  // opinion — each was measured dead against the live database this morning and carries done:false so
  // the reconciler cannot mint an Actual SP for work that has never once run.
  //
  // 8 SP is Kane's ruling for a big ticket ("considered an Epic") and stays a TASK score linked to an
  // existing epic — no new Roadmap rows. That agrees with the board's own rule: on Fibonacci the next
  // step is 13, so "over 8 is an epic" and 8-as-a-task are the same convention.

  // ── Sprint 26 · Aug 13 ───────────────────────────────────────────────────────────────────────
  // 1 SP: two commits, three files, a keyframe sweep moved off Framer Motion onto CSS. The floor of
  // the S26 band and rightly so — no data path, no endpoint, one visual bug.
  { epic: 'HRIS-09', name: 'Employee payroll-processing bar sweeps one direction, driven by CSS', type: 'Bug', sp: 1, done: true, sprint: 'S26' },
  // 2 SP: retiring a sub-team is code-first-then-rate-row (the ordering rule in
  // hsl-placement-only-subteams), so this is a schema edit, a seed-script change and a separately
  // approved delete of the orphaned rate row. Peer of the 2-SP "Collections TL + Simple Texting
  // removed" row, which is literally the same job on a different team.
  { epic: 'HRIS-30', name: 'HSL Lead Nurture sub-team retired — Simple Texting is the only placement-only team', type: 'Chore', sp: 2, done: true, sprint: 'S26' },

  // ── Sprint 26 · Aug 14 ───────────────────────────────────────────────────────────────────────
  // 5 SP: 482 people re-keyed from the KPI Role column, plus three new sub-team rosters seeded and
  // two Guard-8 reports closed. A bulk data migration with a SELECT backup per step (four backup
  // JSONs in the diff) — not 8, because the sub-department MODEL it writes into is its own 8-SP row.
  { epic: 'HRIS-30', name: 'HSL sub-departments bulk-assigned from the KPI Role column (482 people) plus the EGS, Mail Sorting and Executive Assistants rosters', type: 'Chore', sp: 5, done: true, sprint: 'S26' },
  // 5 SP: new API route, a rankings reader, a policies module, both with tests, and a new sidebar
  // section. Sits with the other 5-SP "new tab + new fetch" rows in this sprint.
  { epic: 'HRIS-09', name: 'Employee department directory with SP rankings and per-team policies', type: 'Feature', sp: 5, done: true, sprint: 'S26' },
  // 5 SP: reopen is not the inverse of close — it burns the claim, archives under a prefix that the
  // close-out scan deliberately does not see, and suppresses the re-fire. Two API routes, a store, a
  // trigger module and its tests. Peer of the 5-SP "Close Pay Cycle from the Stop dialog" row it
  // extends.
  { epic: 'HRIS-03a', name: 'Reopen a closed pay cycle, and fire the completion confetti on a clean close', type: 'Feature', sp: 5, done: true, sprint: 'S26' },

  // ── Sprint 26 · Aug 17 (gap day — S26 absorbs Aug 16–17) ─────────────────────────────────────
  // 8 SP, Kane's big-ticket score: five commits, a new tutorial subsystem (guide + narrative modules,
  // both tested), a new API route, two new components and a chat-head shell reworked twice. It is the
  // largest single addition to the wizard since the Validation step. The guide NEVER gates a control
  // and the narrative is render-only, which is what keeps an 8 out of epic territory.
  { epic: 'HRIS-02a', name: 'Payroll Wizard Processing Tutorial Mode — chat-head guide, Sun–Sat processing narrative and rings on the real controls', type: 'Feature', sp: 8, done: true, sprint: 'S26' },
  // 5 SP: deleting a Save button is the small half. The real work is kpiAutosaveGate — never persist a
  // load-seeded value and never persist a just-failed one — across two calculators, with submission
  // still manual. New tested module, 8 files.
  { epic: 'HRIS-06', name: 'KPI Calculator scoring autosaves — the Save button is gone', type: 'Feature', sp: 5, done: true, sprint: 'S26' },
  // 3 SP: a calendar replaces a dropdown, retracts behind a toggle, and the picked week is then pinned
  // through every gate that reads it (resolveIsTechBonusWeek, never the raw flag). Four commits but
  // one screen; the end-to-end pinning is what lifts it off 2.
  { epic: 'HRIS-08', name: 'Tech Bonus week picker becomes a calendar behind a Change week toggle, and the picked week fires that week everywhere', type: 'Feature', sp: 3, done: true, sprint: 'S26' },
  // 3 SP: step-2 rates become cards with flag pairs and the reference detail moves behind info icons;
  // needed a Base UI popover added to components/ui and an index.css rule. Presentation only — no
  // rate, gate or total changed — so it sits below the 5-SP rows that each added a fetch.
  { epic: 'HRIS-02a', name: 'Wizard step-2 conversion rates become cards with flag pairs; Additions declutter behind info icons', type: 'Feature', sp: 3, done: true, sprint: 'S26' },
  // 3 SP: the chime had one global mount, so HR heard payroll money land. Now every mount passes a
  // view and the pairing is tested. Shipped inside a commit whose whole message was "Push".
  { epic: 'HRIS-15', name: 'Notification chimes are view-scoped so HR no longer hears money', type: 'Bug', sp: 3, done: true, sprint: 'S26' },
  // 1 SP: seventeen lines of copy on one card, so an employee reading "Ready to View" is not shown a
  // number that excludes their bonuses. Real, and worth exactly 1.
  { epic: 'HRIS-03b', name: 'Salary “Ready to View” card discloses that bonuses are not in yet', type: 'Feature', sp: 1, done: true, sprint: 'S26' },
  // 5 SP, and done:FALSE — the honesty gate, not a judgement call. 15 files, an employee toast, a live
  // update and its own DDL. Measured against production 2026-08-20: employee_notifications holds ZERO
  // kpi.scored rows against 3,694 payroll.available. The CHECK now permits the type (applied 08-20)
  // but nothing has ever been delivered, so the corrector writes Pending Deploy and no Actual SP.
  { epic: 'HRIS-06', name: 'kpi.scored employee notification — toast plus live update the moment a dept-week is scored', type: 'Feature', sp: 5, done: false, sprint: 'S26', priority: 'High' },

  // ── Sprint 27 · Aug 18 ───────────────────────────────────────────────────────────────────────
  // 8 SP, Kane's big-ticket score: this is a payroll RULING, not a UI change. Snap-to-Sunday was the
  // root cause and is deleted, changed weeks now price two 2dp legs, and HSL transition OT counts
  // every hour. 16 files, an audit script and a fix script, both run. It REVERSES the Done S26 row
  // "Rate-history effective_from snapped to the pay-week start" (c39fad3b) — see that row's update.
  { epic: 'HRIS-02b', name: 'Mid-week rate-change effective dates are real — snap-to-Sunday removed, changed weeks price 2dp legs, HSL transition OT counts every hour', type: 'Bug', sp: 8, done: true, sprint: 'S27', priority: 'High' },
  // 3 SP: an activity feed at each pane's bottom plus submitted-by/when on KPI rows. Audited SAVES
  // only, never presence, and templates never print details — a deliberately narrow read.
  { epic: 'HRIS-20', name: 'Payroll Readiness recent-changes activity feed, and KPI rows show who submitted and when', type: 'Feature', sp: 3, done: true, sprint: 'S27' },
  // 3 SP: the Offboarded pane goes cached+live with search and a dept filter, every pane stamps its
  // last data pull, a Realtime signal dot reports emerald/amber honestly, and the Rates tab is
  // removed. Four panes touched, one removed — 3, not 5, because no new data source appeared.
  { epic: 'HRIS-21', name: 'Payroll Notes Offboarded pane cached and live with filters, a per-pane data-pull stamp and a Realtime signal dot', type: 'Feature', sp: 3, done: true, sprint: 'S27' },
  // 3 SP: bonuses and adjustments itemized through the shared report-rows builder so the wizard
  // Reports, the PDF and the Overview CSV agree line for line, with a fetch failure ABORTING the
  // export rather than quietly shipping a short one. 9 files, one new route.
  { epic: 'HRIS-02a', name: 'Wizard Reports and Overview CSV itemize bonuses and adjustments end-to-end', type: 'Feature', sp: 3, done: true, sprint: 'S27' },
  // 2 SP: the badge was its own predicate and disagreed with the wizard. Now both read the same
  // 30-day pay gate, anchored on the cycle week start. Two files plus an INDEX row.
  { epic: 'HRIS-08', name: 'Overview Tech Eligible badge uses the wizard’s own 30-day pay gate', type: 'Bug', sp: 2, done: true, sprint: 'S27' },
  // 2 SP: seventeen lines, but it is money — orphanage OT was pricing at the 0.5× weekly differential
  // instead of the full 1.5×. Small diff, real underpay, hence 2 rather than 1.
  { epic: 'HRIS-03c', name: 'Orphanage OT prices at the full 1.5× rate, never the 0.5× differential', type: 'Bug', sp: 2, done: true, sprint: 'S27', priority: 'High' },

  // ── Sprint 27 · Aug 19 ───────────────────────────────────────────────────────────────────────
  // 8 SP, Kane's big-ticket score, and done:FALSE. Ten commits, a new API route pair, a Haiku client,
  // self-only tools, guides, a Markdown renderer and greeting chips. Measured 2026-08-20: the table
  // penny_employee_usage DOES NOT EXIST in production (PGRST205, the same signature a control
  // nonexistent table returns). The row count IS the quota and the check fails closed, so the feature
  // cannot serve a prompt. Pending Deploy until the migration runs.
  { epic: 'HRIS-09', name: 'Employee Penny AI on the Overview — Haiku, self-only tools, 10 prompts per Manila day, with guides and rendered Markdown', type: 'Feature', sp: 8, done: true, sprint: 'S27', priority: 'High' },
  // 5 SP, and done:FALSE. Dual sign-off that can land in either order, a manager-named second approver
  // per request, 13 files. Measured 2026-08-20: ALL FOUR of second_approver_email, second_decision,
  // manager_decision and second_approver_assigned_by are absent from time_adjustment_requests. The
  // migration has not run, so the feature is code-complete and functionally dead.
  { epic: 'HRIS-04', name: 'Time adjustments need two sign-offs — the manager names a second approver per request', type: 'Feature', sp: 5, done: true, sprint: 'S27', priority: 'High' },
  // 5 SP: three commits, 12 files, two new band components and a tested bank-mix module. Two
  // RAIL-shaped cards (send-from and payable-per-rail), roster-scoped rather than feed-scoped, dept
  // filter, and never a bank name. Peer of the 5-SP "Bank rail parity" row from S26.
  { epic: 'HRIS-19', name: 'People → Bank changes band: send-from and payable-per-rail cards, per-rail counts, dept filter, no bank names', type: 'Feature', sp: 5, done: true, sprint: 'S27' },
  // 5 SP: a three-format export at MASTER-LIST grain, so never-submitted people are the point rather
  // than an omission, with off-roster submitters appended and flagged. New tested module, new reader,
  // 1,714 lines. Never a price — the gift feature is info-only.
  { epic: 'HRIS-32', name: 'Gift Tracker tenure-gift roster export (CSV/XLSX/PDF) at master-list grain', type: 'Feature', sp: 5, done: true, sprint: 'S27' },
  // 5 SP: merges the Global Master List into the team-members roster so a placement alone reaches the
  // Wizard rail, with the plain-name fallback deliberately DROPPED. Authored on a branch on Aug 3 and
  // merged Aug 19 — the row's last sha is therefore the MERGE commit, because the branch commits carry
  // Aug 3 dates and would attribute this to a sprint it did not land in.
  { epic: 'HRIS-30', name: 'HSL KPI roster merged with the Global Master List — a placement alone reaches the Wizard rail', type: 'Feature', sp: 5, done: true, sprint: 'S27' },
  // 2 SP: DialogContent has no height cap, so a p-0 dialog pushed its footer off-screen. The fix is a
  // dvh cap plus gap-0, and the finding generalises to every p-0 dialog — which is why it is 2, not 1.
  { epic: 'HRIS-15', name: 'p-0 dialogs get a dvh height cap so a modal footer can never go unreachable', type: 'Bug', sp: 2, done: true, sprint: 'S27' },
  // 1 SP: an Edit button on the Bonus Library cards. Two files, 59 lines.
  { epic: 'HRIS-06', name: 'Payment Catalog Bonus Library cards get an Edit button', type: 'Feature', sp: 1, done: true, sprint: 'S27' },

  // ── Backlog · Unscheduled — opened by measurement 2026-08-20, none of it started ──────────────
  // 3 SP, CRITICAL: probeTable() does select('*', {head:true,count:'exact'}) and treats "no error" as
  // APPLIED — but PostgREST returns NO ERROR for a table that does not exist, just count:null. Proven
  // twice today, on penny_employee_usage and on a control table named definitely_not_a_table_xyz;
  // the positive control returns count=181799, which is why it was never noticed. probeColumn() is
  // wrong differently: a missing column errors with code:undefined and an empty message, matching no
  // branch, so it lands INCONCLUSIVE instead of NOT APPLIED. Consequence: every table-creating
  // migration that never ran was counted APPLIED, and the S27 migrations row was closed Done on it.
  { epic: 'HRIS-15', name: 'audit-pending-migrations reports a MISSING table as APPLIED — head:true returns no error', type: 'Bug', sp: 3, done: false, sprint: 'S27', priority: 'Critical' },
  // 3 SP: hours ride lawangc@ against a stale 175 employee-scope override while the person's real
  // identity sits on another row. The fix script exists (committed inside a commit messaged "ss") and
  // has never been run — it needs Kane's --apply and a SELECT backup first.
  { epic: 'HRIS-02b', name: 'Lawang rate shadow: hours ride lawangc@ on a stale 175 employee-scope override', type: 'Bug', sp: 3, done: false, sprint: 'BL', priority: 'High' },
  // 2 SP: measured today — glendac@, domv@, beao@, joee@ and jesr@ each hold a scope:'employee' row in
  // payment_catalog_pay_structures keyed to department_key 'hsl', seeded by "rate-divergence fix
  // 2026-07-29". No DEPT-scope bare-hsl row exists, so the parent-cutover claim holds; but an
  // employee-scope override on a key that is no longer placeable is the exact shape of the Lawang
  // underpay, and nothing re-derives these.
  { epic: 'HRIS-02b', name: 'Five employees still hold a rate override keyed to the retired bare hsl department', type: 'Bug', sp: 2, done: false, sprint: 'BL', priority: 'High' },
  // ── 2026-08-19 work the 08-20 logging pass did not cover ──────────────────────────────────────
  // Kane 2026-08-20: "Every single success yesterday that wasnt added to the monday board let us push
  // to monday." The 28-row pass earlier today caught the day's headline features; these four are what
  // was left. Two are sub-features that the bundled Penny row does NOT describe, and two are the
  // day's tooling/documentation work, which no pass has ever logged.
  //
  // 3 SP: six commits of proactive-greeting behaviour (e8ef4ff2..7d7688cc) — the bubble opens itself
  // 5s after the Overview mounts, offers five chips drawn fresh from a larger pool each refresh, and
  // the panel matches. The bundled HRIS-09 Penny row covers the CHAT (Haiku, tools, quota, guides,
  // Markdown) and says nothing about a greeting; two of the six commits are fixes to this behaviour
  // alone (the timer never fired; the panel showed the whole pool), which is what makes it its own row.
  { epic: 'HRIS-09', name: 'Penny greets employees on the Overview — five rotating chips from a larger pool', type: 'Feature', sp: 3, done: true, sprint: 'S27', priority: 'High' },
  // 2 SP: its own module (src/lib/penny/pay-status.ts), its own tests and a 233-line read-only audit
  // script. Penny was telling employees that already-PAID weeks were still pending — a wrong answer
  // about their own money, which is a different failure class from the chat feature shipping.
  { epic: 'HRIS-09', name: 'Penny told employees their already-paid weeks were still pending', type: 'Bug', sp: 2, done: true, sprint: 'S27', priority: 'High' },
  // 3 SP: the two approval-gate holes. Sprint moves were neither shown nor hashed, so an approval did
  // not bind the re-filings it authorised (two passes went through that hole), and the hash bound the
  // proposal FILE rather than the working tree, so a stale proposal could authorise writes it never
  // described. Both closed and both since exercised for real.
  { epic: 'HRIS-15', name: 'Board-sync approval binds the sprint moves and the working tree, not just the proposal file', type: 'Chore', sp: 3, done: true, sprint: 'S27' },
  // 2 SP: twelve feature docs, ten sessions of undocumented behaviour. Not a feature, and logged
  // anyway — the governing docs are what the hardening and blueprint skills read at step 1, so a gap
  // there is a gap in every later decision. This is the row that says the docs are not free.
  { epic: 'HRIS-15', name: 'Feature docs back-filled — ten sessions of gaps closed across twelve documents', type: 'Chore', sp: 2, done: true, sprint: 'S27' },
  // ── 2026-08-20 (yesterday, relative to 2026-08-21) ────────────────────────────────────────────
  // Kane: "Any task accomplished yesterday should be added into the board with their respective SP."
  // Ten commits. Six were board passes and documentation and collapse into one Chore row; four are
  // substantive. NOTE THE WINDOW: pass 6 ran at 07:36 on 08-21 and read "yesterday" as 08-19, so
  // 08-20 had never been logged at all.
  //
  // 2 SP: the bubble now rides every tab rather than the Overview alone. Deliberately NOT folded into
  // the Penny AI row — that row is the chat engine; this is placement. The GREETING stays Overview-only.
  { epic: 'HRIS-09', name: 'Employee Penny chat bubble rides every tab, not just the Overview', type: 'Feature', sp: 2, done: false, sprint: 'S27' },
  // 2 SP: the pre-flight IS the accomplished task — 77 queued deletions measured and 22 of them
  // colliding with CURRENT non-offboarded people, caught before anyone set CRON_SECRET.
  { epic: 'HRIS-01a', name: 'Deletion-cron pre-flight: 77 queued deletions measured, 22 colliding with current staff', type: 'Spike', sp: 2, done: true, sprint: 'S27' },
  // 3 SP CRITICAL, its own OPEN row because the pre-flight only MEASURED. The cron still trusts
  // scheduled_deletion_at alone and never re-checks the live roster at fire time, so the guard its own
  // comment claims does not exist in code. A lone Done row would have read as "handled".
  { epic: 'HRIS-01a', name: 'Deletion cron never re-checks the live roster, so 22 current employees are still queued for deletion', type: 'Bug', sp: 3, done: false, sprint: 'S27', priority: 'Critical' },
  // 2 SP: both 2026-08-19 migrations had silently never applied because the password's `@` was not
  // percent-encoded in DATABASE_URL — an unencoded @ truncates the host instead of erroring.
  { epic: 'HRIS-15', name: 'Migration applies never ran: an unencoded @ in DATABASE_URL silently truncated the host', type: 'Bug', sp: 2, done: true, sprint: 'S27' },
  // 3 SP: six commits of board and documentation work in one day.
  { epic: 'HRIS-15', name: 'Board-sync logged the undocumented week and corrected the skill’s stale drift entries', type: 'Chore', sp: 3, done: true, sprint: 'S27' },
  // ── Found 2026-08-21 while closing the PAB audit row ──────────────────────────────────────────
  // 3 SP: `insertAuditLog` returns `{ error }` and **197 of its 201 call sites discard it**, while the
  // helper itself neither logs nor throws. So every audit write in the product can fail with no
  // signal anywhere — in the one table this product treats as its trail of record. Measured, not
  // estimated: only app/api/audit-log/route.ts, payment-dispatches/undo (x2) and
  // notify-failure-audit.ts capture the result. The fix is CENTRAL (make the helper surface its own
  // failure), not 197 call-site edits — which is why this is 3 SP and not 13.
  //
  // This is also the bug that fooled ME on 2026-08-21: I read 0 audit rows as "the write failed",
  // when the write had succeeded and my QUERY was broken. Had the write actually failed, there would
  // have been nothing to distinguish the two — which is the whole problem.
  { epic: 'HRIS-15', name: 'Audit writes fail silently: insertAuditLog’s error is discarded at 197 of 201 call sites', type: 'Bug', sp: 3, done: false, sprint: 'S27', priority: 'High' },
  // ── Requested by Kane 2026-08-21 ─ not started ──────────────────────────────────────
  // 5 SP, and the FIRST task row under HRIS-17, which has carried 20 SP with zero children since the
  // board shipped in July. A ticket today emails on three things only: created (to the owner),
  // assigned (to the dev) and done (to the creator) — so a requester hears nothing between filing and
  // shipping. Two new n8n hooks close that: a comment mails the COUNTERPARTY (creator, or the dev when
  // the creator is the one who typed it — exactly mirroring the in-app `ticket.replied` leg, which
  // already ships and is the reason this is not 8 SP), and ANY status move mails the creator, with
  // `done` still riding notifyTicketDone. Scored 5 because it carries a new `ticket.moved` notification
  // type, and a new type is DEAD until the employee_notifications CHECK widen runs — the same footgun
  // that left kpi.scored rejected for three days behind a console.warn. That DDL plus two n8n imports
  // are Kane's to run, so this row cannot pass Pending Deploy on code alone.
  { epic: 'HRIS-17', name: 'Tickets board notifies the requester on every update — comment emails and status-move emails', type: 'Feature', sp: 5, done: false, sprint: 'S27' },
  // 2 SP: `HUBSTAFF_EXEMPT_DEPTS` matches raw master-list labels exactly, and the dept it excuses was
  // renamed — `Site Building` became `Site Building (US - Freelance)` (20 people, ZERO with Hubstaff
  // hours) and `Site Building (PH - Freelancer)` (13, zero) — so the list silently inverted its own
  // meaning and the Overview "Hubstaff ↔ Master matches" tile (and its CEO mirror) reported 33
  // deliberately-untracked freelancers as unexplained reconciliation gaps. The untouched
  // `SMM Freelancer` label kept working, which is how it stayed invisible. Fixed by retrying the
  // match once with a trailing parenthetical qualifier stripped; a test pins the negative control
  // (a dept whose base label was never exempt stays tracked however it is qualified) and pins
  // Lead Gen NOT exempt per Kane. 2 SP: one predicate and its tests, no new surface.
  { epic: 'HRIS-14', name: 'Hubstaff exempt-department list broke on a rename, reporting 33 untracked freelancers as unexplained gaps', type: 'Bug', sp: 2, done: false, sprint: 'S27', priority: 'High' },
  // 5 SP: nobody had offboarded jvincec@ and nothing said so — he sat Active with zero hours from
  // 2026-08-05. The DETECTOR already existed (the Overview recon tile had him in its gap bucket the
  // whole time, approved-leave carve-out included); what was missing was delivery, so this is a
  // noise fix plus two delivery paths, not a new engine. `classifyZeroHours` is extracted as the ONE
  // rule now shared by that tile, a new Readiness "No Hours" tab and a `payroll.hours_gap`
  // notification fired on Hubstaff ingest to accounting role holders only. Scored 5, not 8, because
  // it touches NO money path — no score component, no rate, no dispatch row — and deliberately so:
  // Lead Gen stays tracked per Kane, which puts ~193 rows on the list every week, so the dimension
  // is listed and never scored (a fourth score component would peg readiness near zero weekly and
  // kill the 100% celebration). Not 3, because it carries a new notification type with its own
  // employee_notifications CHECK widen, 44 new tests, and the exempt-list bug as a prerequisite.
  // The DDL is APPLIED and verified (43 types live, all 39 app-mapped types still admitted), so
  // unlike the tickets row above this one is not blocked on a migration — it is blocked only on the
  // push, and the first real insert is unproven until the next ingest.
  { epic: 'HRIS-20', name: 'Accounting is told who logged no Hubstaff hours — one shared no-hours rule, a Readiness tab and an ingest notification', type: 'Feature', sp: 5, done: false, sprint: 'S27' },
  // ── Sprint 27 · Aug 21-24 · undeclared until the 2026-08-24 pass ─────────────────────────────
  // 5 SP across THREE commits that all rewrite the same tested module (`dept-rail.ts`) and the same
  // screen, so they are one row, not three: 24d6d0a1 built it, 6cb643b2 and 47e84590 hardened it the
  // same day. The rail is a TREE — a Pay Structure renders under the member's PLACEMENT, not under
  // whatever departmentKey it happens to store, and the bare parent claims NOBODY, which is why the
  // HSL sub-teams nest under a retractable Hogan Smith Law instead of flattening into it. 6cb643b2
  // then resolved a structure's owner by IDENTITY rather than by email alone (Baldonebro was being
  // held by the parent because the email matched first), and 47e84590 closed an adder guard that
  // could overwrite a live rate from a blank form, plus five more review findings. Peer of the 5-SP
  // "People → Bank changes band" row: a new tested module plus one screen, no money path, no table.
  // Not 8 — it prices nothing and dispatches nothing; not 3 — 264 lines of new rule with 269 lines
  // of test, a 598-line screen change, and two same-day hardening passes on top.
  { epic: 'HRIS-06', name: 'Pay Structure shows a department’s members, with the HSL sub-teams nested under a retractable parent', type: 'Feature', sp: 5, done: false, sprint: 'S27' },
  // 5 SP: the Payment Catalog was still listing people who had left. Four new tested modules —
  // catalog-roster-visibility, offboard-evidence, master-date and catalog-offboarded-emails — and
  // every one of the four guards deliberately fails toward KEEPING a person, because dropping someone
  // who is still employed is the worse error. Evidence is read on WORK emails only. Measured at the
  // time: active_employees carried 0 stamped and 294 gone. 110 lines came OUT of payroll-readiness.ts
  // as the rule was centralised. Not 8: no money path, no new table, no dispatch row. Not 3: four new
  // modules, 272 lines of test, and a behavioural change to who appears on a live Accounting screen.
  { epic: 'HRIS-06', name: 'Offboarded people drop off the Payment Catalog, behind four guards that all fail toward keeping them', type: 'Feature', sp: 5, done: false, sprint: 'S27' },
  // 5 SP for 56390cb9 + de0fa485, one row: de0fa485 only re-animates ValidationFullScreen.tsx, the
  // component 56390cb9 created, so it is the same feature finishing rather than a second one. A named
  // human vouches for ONE person's pay and Lenny sees that vouch at Mark Paid. New route, a tested
  // manual-validation module, a hook, the full-screen overlay and the Mark Paid surfacing. Scored 5
  // and NOT 8 despite ~1,750 lines: it RECORDS a human judgement and never prices anything — no rate,
  // no amount, no score component moves — so the money-math risk that earns 8 (the mid-week rate
  // proration row, the HSL sub-department cutover) is absent here. The one genuinely novel part is
  // that the validation cannot live on payment_dispatches, because at step 7 no dispatch row exists
  // yet, so it rides an app_settings blob written compare-and-swap; Mark Paid keys it on row.id,
  // which is the WORK email. Not 3: a new route, a new persistence pattern and a money-critical
  // dialog touched.
  { epic: 'HRIS-02a', name: 'Payroll Wizard manual validation — a named human vouches for one person’s pay, and Mark Paid shows it', type: 'Feature', sp: 5, done: false, sprint: 'S27' },
  // 3 SP, and deliberately a SECOND row rather than an edit of the Done 2-SP row
  // "Orphanage OT prices at the full 1.5× rate, never the 0.5× differential" (S27). That row was a
  // seventeen-line price correction; this is the hardening that followed it — pricing extracted into
  // orphanage-pay-pricing.ts as the one rule with its own test file, below-regular OT REFUSED outright
  // rather than silently accepted, an audit script for the divergence, and the 2026-08-09 week
  // repaired. It does not reverse the earlier row, it makes the same rule unfalsifiable, so both rows
  // stand. Not 2: an extraction, a refusal guard, an audit script and a data repair is more than the
  // fix was. Not 5: one pricing rule, no new surface. OPEN and NOT part of this row: erict@'s ₱5,373
  // is still invisible, and the blob is still last-writer-wins.
  { epic: 'HRIS-03c', name: 'Orphanage OT pricing extracted and tested, with below-regular OT refused outright', type: 'Bug', sp: 3, done: false, sprint: 'S27', priority: 'High' },
  // 3 SP: wide and shallow — 48 files, but LABEL ONLY. The stored value `hurupay` never moves, so no
  // history is rewritten and no dispatch re-routes; `kolan` is aliased in all three normalisers, which
  // must agree or the rail breaks. Carries a new payout-brand module with tests and a migration
  // (add_payout_brand_to_onboarding.sql plus its apply script). Not 5: no logic changed, nothing
  // reprices. Not 2: 48 files, a new column, and three normalisers that fail as one.
  { epic: 'HRIS-03a', name: 'Hurupay is renamed Kolan everywhere a human reads it, with the stored value left untouched', type: 'Chore', sp: 3, done: false, sprint: 'S27' },
];
