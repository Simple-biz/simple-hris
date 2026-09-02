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
  // Added by hand on the board and mirrored 2026-09-01 from the live group list
  // ("Sprint 28 · Sep 1-Sep 12 · Backlog Pull").
  S28: 'group_mm6nv017',
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
export type TaskPriority = 'Critical' | 'High' | 'Medium' | 'Low' | null;
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
  // S28 = 104, read off settings_str 2026-09-01 — the indices keep not being sequential.
  S17: 8, S18: 9, S19: 10, S20: 11, S21: 12, S22: 3, S23: 4, S24: 0, S25: 1, S26: 13, S27: 103, S28: 104, BL: 2,
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
  S28: 'Sprint 28',
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
  // Added 2026-09-01 from the live group title "Sprint 28 · Sep 1-Sep 12". Adding it re-bounds S27's
  // attribution to Aug 18-31, giving the gap days Aug 30-31 a sprint to belong to.
  S28: { start: '2026-09-01', end: '2026-09-12' },
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
  Medium: 2,
  Low: 3,
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
  // Rolled S27 → S28 on 2026-09-01: unfinished at sprint close (Kane: pending rows with no Actual SP
  // move to 28 "and we will finish them from there"). Status untouched by the move.
  { epic: 'HRIS-14', name: 'Google Sheet sync crons (master / rates / HSL / offboarded) — split of legacy Csv Imports', type: 'Integration', sp: 5, done: false, sprint: 'S28' },
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
  // Rolled S27 → S28 on 2026-09-01: unfinished at sprint close. Status untouched by the move.
  { epic: 'HRIS-19', name: 'Legacy rates-sheet cell can route null-preferred → hurupay: decision + guard', type: 'Spike', sp: 2, done: false, sprint: 'S28', priority: 'High' },
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
  { epic: 'HRIS-06', name: 'kpi.scored employee notification — toast plus live update the moment a dept-week is scored', type: 'Feature', sp: 5, done: true, sprint: 'S26', priority: 'High' },

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
  { epic: 'HRIS-15', name: 'audit-pending-migrations reports a MISSING table as APPLIED — head:true returns no error', type: 'Bug', sp: 3, done: true, sprint: 'S27', priority: 'Critical' },
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
  // done:false → true 2026-09-02: the board row (12863017153) has read Done with Actual SP 2 and a
  // Completed Date of 2026-08-20 since pass 6, and the employee-penny-ai memory records the bubble on
  // ALL tabs from that day. The plan was the stale side, and its done:false cost the rollup 2 SP.
  { epic: 'HRIS-09', name: 'Employee Penny chat bubble rides every tab, not just the Overview', type: 'Feature', sp: 2, done: true, sprint: 'S27' },
  // 2 SP: the pre-flight IS the accomplished task — 77 queued deletions measured and 22 of them
  // colliding with CURRENT non-offboarded people, caught before anyone set CRON_SECRET.
  { epic: 'HRIS-01a', name: 'Deletion-cron pre-flight: 77 queued deletions measured, 22 colliding with current staff', type: 'Spike', sp: 2, done: true, sprint: 'S27' },
  // 3 SP CRITICAL, its own OPEN row because the pre-flight only MEASURED. The cron still trusts
  // scheduled_deletion_at alone and never re-checks the live roster at fire time, so the guard its own
  // comment claims does not exist in code. A lone Done row would have read as "handled".
  // Rolled S27 → S28 on 2026-09-01: unfinished at sprint close. Status untouched by the move.
  { epic: 'HRIS-01a', name: 'Deletion cron never re-checks the live roster, so 22 current employees are still queued for deletion', type: 'Bug', sp: 3, done: false, sprint: 'S28', priority: 'Critical' },
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
  // Rolled S27 → S28 on 2026-09-01: unfinished at sprint close. Status untouched by the move.
  { epic: 'HRIS-15', name: 'Audit writes fail silently: insertAuditLog’s error is discarded at 197 of 201 call sites', type: 'Bug', sp: 3, done: false, sprint: 'S28', priority: 'High' },
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
  // Rolled S27 → S28 on 2026-09-01: unfinished at sprint close. Board status stays Pending Deploy —
  // the sprint move changes WHERE it is filed, not how far along it is; the CHECK widen + two n8n
  // imports are still Kane's to run.
  { epic: 'HRIS-17', name: 'Tickets board notifies the requester on every update — comment emails and status-move emails', type: 'Feature', sp: 5, done: false, sprint: 'S28' },
  // 2 SP: `HUBSTAFF_EXEMPT_DEPTS` matches raw master-list labels exactly, and the dept it excuses was
  // renamed — `Site Building` became `Site Building (US - Freelance)` (20 people, ZERO with Hubstaff
  // hours) and `Site Building (PH - Freelancer)` (13, zero) — so the list silently inverted its own
  // meaning and the Overview "Hubstaff ↔ Master matches" tile (and its CEO mirror) reported 33
  // deliberately-untracked freelancers as unexplained reconciliation gaps. The untouched
  // `SMM Freelancer` label kept working, which is how it stayed invisible. Fixed by retrying the
  // match once with a trailing parenthetical qualifier stripped; a test pins the negative control
  // (a dept whose base label was never exempt stays tracked however it is qualified) and pins
  // Lead Gen NOT exempt per Kane. 2 SP: one predicate and its tests, no new surface.
  { epic: 'HRIS-14', name: 'Hubstaff exempt-department list broke on a rename, reporting 33 untracked freelancers as unexplained gaps', type: 'Bug', sp: 2, done: true, sprint: 'S27', priority: 'High' },
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
  { epic: 'HRIS-20', name: 'Accounting is told who logged no Hubstaff hours — one shared no-hours rule, a Readiness tab and an ingest notification', type: 'Feature', sp: 5, done: true, sprint: 'S27' },
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
  { epic: 'HRIS-06', name: 'Pay Structure shows a department’s members, with the HSL sub-teams nested under a retractable parent', type: 'Feature', sp: 5, done: true, sprint: 'S27' },
  // 5 SP: the Payment Catalog was still listing people who had left. Four new tested modules —
  // catalog-roster-visibility, offboard-evidence, master-date and catalog-offboarded-emails — and
  // every one of the four guards deliberately fails toward KEEPING a person, because dropping someone
  // who is still employed is the worse error. Evidence is read on WORK emails only. Measured at the
  // time: active_employees carried 0 stamped and 294 gone. 110 lines came OUT of payroll-readiness.ts
  // as the rule was centralised. Not 8: no money path, no new table, no dispatch row. Not 3: four new
  // modules, 272 lines of test, and a behavioural change to who appears on a live Accounting screen.
  { epic: 'HRIS-06', name: 'Offboarded people drop off the Payment Catalog, behind four guards that all fail toward keeping them', type: 'Feature', sp: 5, done: true, sprint: 'S27' },
  // 5 SP for 56390cb9 + de0fa485, one row: de0fa485 only re-animates ValidationFullScreen.tsx, the
  // component 56390cb9 created, so it is the same feature finishing rather than a second one. A named
  // human vouches for ONE person's pay and Lenny sees that vouch at Mark Paid. New route, a tested
  // manual-validation module, a hook, the full-screen overlay and the Mark Paid surfacing. Scored 5
  // and NOT 8 despite ~1,750 lines: it RECORDS a human judgement and never prices anything — no rate,
  // no amount, no score component moves — so the money-math risk that earns 8 (the mid-week rate
  // proration row, the HSL sub-department cutover) is absent here. The one genuinely novel part is
  // that the validation cannot live on payment_dispatches, because at Validation (step 6) no dispatch row exists
  // yet, so it rides an app_settings blob written compare-and-swap; Mark Paid keys it on row.id,
  // which is the WORK email. Not 3: a new route, a new persistence pattern and a money-critical
  // dialog touched.
  { epic: 'HRIS-02a', name: 'Payroll Wizard manual validation — a named human vouches for one person’s pay, and Mark Paid shows it', type: 'Feature', sp: 5, done: true, sprint: 'S27' },
  // 3 SP, and deliberately a SECOND row rather than an edit of the Done 2-SP row
  // "Orphanage OT prices at the full 1.5× rate, never the 0.5× differential" (S27). That row was a
  // seventeen-line price correction; this is the hardening that followed it — pricing extracted into
  // orphanage-pay-pricing.ts as the one rule with its own test file, below-regular OT REFUSED outright
  // rather than silently accepted, an audit script for the divergence, and the 2026-08-09 week
  // repaired. It does not reverse the earlier row, it makes the same rule unfalsifiable, so both rows
  // stand. Not 2: an extraction, a refusal guard, an audit script and a data repair is more than the
  // fix was. Not 5: one pricing rule, no new surface. OPEN and NOT part of this row: erict@'s ₱5,373
  // is still invisible, and the blob is still last-writer-wins.
  { epic: 'HRIS-03c', name: 'Orphanage OT pricing extracted and tested, with below-regular OT refused outright', type: 'Bug', sp: 3, done: true, sprint: 'S27', priority: 'High' },
  // 3 SP: wide and shallow — 48 files, but LABEL ONLY. The stored value `hurupay` never moves, so no
  // history is rewritten and no dispatch re-routes; `kolan` is aliased in all three normalisers, which
  // must agree or the rail breaks. Carries a new payout-brand module with tests and a migration
  // (add_payout_brand_to_onboarding.sql plus its apply script). Not 5: no logic changed, nothing
  // reprices. Not 2: 48 files, a new column, and three normalisers that fail as one.
  { epic: 'HRIS-03a', name: 'Hurupay is renamed Kolan everywhere a human reads it, with the stored value left untouched', type: 'Chore', sp: 3, done: true, sprint: 'S27' , priority: 'Medium' },
  // ── Sprint 27 · Aug 24-25 · undeclared until the 2026-08-25 pass ─────────────────────────────
  // 5 SP: an unrouted person could not be sent to Kolan or HiGlobe at all — the wallet rails were
  // absent from the assignable set — and nothing tied picking one to the Disbursement rail, so a
  // wallet payee could sit with a bank rail underneath them. Picking either now MIRRORS into
  // Disbursement, and a new `wallet-rail-lock` module reads the EFFECTIVE rail across three tiers
  // and FAILS CLOSED: unset is not locked, so an unknown rail is never treated as permission. Peer
  // of the 5-SP "People → Bank changes band" row — a new tested guard plus the screens and routes
  // that have to agree with it (three API routes, three components, two test files). Not 8: it
  // reprices nothing and moves no money. Not 3: it changes who can be routed where, on the rail.
  { epic: 'HRIS-19', name: 'Kolan and HiGlobe are assignable when a person is unrouted, and picking one sets the Disbursement rail', type: 'Feature', sp: 5, done: true, sprint: 'S27' , priority: 'High' },
  // 3 SP across four commits that all rewrite the SAME file (Overview.tsx) on the same day — one
  // build (38670c4c) and three same-day fit-and-finish passes — so file overlap makes them one row.
  // The Expanded roster table leads with the person rather than the ID, and its sort and page size
  // are SHARED with the Simple view so the two cannot disagree. Not 5: no new module, no test file,
  // no money path — it is one screen. Not 2: 452 net lines across four passes, and a shadcn Table
  // component had to be abandoned because it breaks sticky headers.
  { epic: 'HRIS-11', name: 'Overview Expanded roster table leads with the person, with shared sort and page size', type: 'Feature', sp: 3, done: true, sprint: 'S27' , priority: 'Medium' },
  // 3 SP: raw `hsl:*` department keys were leaking into rendered UI across the app, so people read
  // `hsl:filing_specialist` on screens meant for humans. `formatDeptLabel` is now applied app-wide
  // (a no-op off HSL) across 54 files, and a scan test guards the regression. Deliberately NARROW:
  // the raw key is KEPT in exports, tooltips, search haystacks and filter VALUES, because those are
  // machine-side and collapsing them would break matching. Peer of the 3-SP Kolan rename — wide,
  // shallow, label-only. Not 5: no logic moves. Not 2: 54 files plus a 137-line render test and a
  // scan guard. OPEN and NOT closed by this row: the headcount cards still group on the raw key.
  { epic: 'HRIS-30', name: 'Raw hsl: department keys stop reaching human-readable screens — formatDeptLabel applied app-wide', type: 'Bug', sp: 3, done: true, sprint: 'S27' , priority: 'Medium' },
  // 3 SP: the People roster export gained the masked account last 4 and the date the bank last
  // changed. Masking is done SERVER-side, never in the browser, and the export is slot-aware (8
  // people sit on an alternate slot). The date comes from `bank_update_history` and NEVER from the
  // self-update stamp, which records a different event. Two small new modules (mask-account,
  // bank-update-history) with 246 lines of test and a 166-line feature doc. Not 5: it adds two
  // columns to an export that already existed, where the 5-SP Gift Tracker export built a new one.
  // Not 2: bank data leaving the system is a disclosure surface, which is why masking is server-side.
  { epic: 'HRIS-23', name: 'People roster export carries the masked account last 4 and the date the bank last changed', type: 'Feature', sp: 3, done: true, sprint: 'S27' , priority: 'High' },
  // 3 SP, High: on 2026-08-21 an HSL hire was emailed the Lead Gen orientation Zoom link, because
  // nothing anywhere scoped the send by department — the live n8n flow was Webhook → Split Out →
  // Gmail with no filter at all. The gate now lives in the SENDER (`isLeadGenDepartment`, the same
  // predicate that gates the CallTools webhook, so both orientation surfaces agree on who is Lead
  // Gen), and it FAILS CLOSED: blank, NULL or unrecognised department is not Lead Gen. Withheld
  // hires are never silent — they return in `webhook.skipped` with a reason and their own toast.
  // The n8n Filter node is a deliberate SECOND layer, not the fix. Not 2: it is a live incident with
  // a two-layer remedy and 121 lines of new test. Not 5: one predicate, one payload builder.
  { epic: 'HRIS-24', name: 'Only Lead Gen hires get the orientation email — gated in the sender, failing closed on a blank department', type: 'Bug', sp: 3, done: true, sprint: 'S27' , priority: 'High' },
  // 3 SP, High: a payroll week that could not be resolved from a batch FILENAME left the KPI
  // Calculator on a skeleton forever — the skeleton was terminal, with no error state and no way
  // out. Two fixes, one row: the reveal is now a tested rule (`kpi-calculator-reveal`) so an
  // unresolved week surfaces instead of hanging, and undatable batch names are REFUSED AT INGEST so
  // the bad state cannot be created again. Fixing only the screen would have left the data able to
  // re-poison it. Not 2: three new modules and a change to what ingest accepts. Not 5: no money
  // path, no new surface.
  { epic: 'HRIS-06', name: 'An unresolvable payroll week stops being a forever-loading KPI Calculator screen', type: 'Bug', sp: 3, done: true, sprint: 'S27' , priority: 'High' },
  // 2 SP: Attestation now pays Referral Leads and SSA.Gov at ₱250 on TOP of the case tier, and the
  // tier itself still reads CASES only — the two must not be conflated or the tier inflates. Nine
  // lines of schema change with 84 lines of test and the verifier extended. NOT retroactive, by
  // Kane's call. 2 SP and not 3 because it is one rule in one schema, but not 1 because it pays real
  // money and a wrong tier boundary overpays every member of the department.
  { epic: 'HRIS-30', name: 'Attestation pays Referral Leads and SSA.Gov on top of the case tier', type: 'Feature', sp: 2, done: true, sprint: 'S27' , priority: 'High' },
  // 5 SP across three commits on the same panel and model — 06f7f669 built it, d08a9948 stamped the
  // doc, d24b49a8 lifted it into its own tab. Manager → My Team → Orientation carries a weekly
  // attendance tally, per-week drill-down and PDF export. Two facts decided the design and both are
  // load-bearing: it is an INNER tab, because a new top-level tab is a new feature key and no row
  // means hidden, so nobody but an admin would have seen it; and attendance is the STAMP
  // (`orientation_attended_at`), never `status` — live rows carry both stamps with status `no_show`
  // and vice versa. The week key is HR checklist `period_start`, replacing a date-derived key that
  // was 46% wrong (439 of 954 hires filed a week early). Not 8: no money path, no new table, and the
  // My Team no-comp rule means the PDF carries no money column. Not 3: a new API route, a 261-line
  // tested model, a 439-line PDF builder, a new panel and a hook.
  { epic: 'HRIS-10', name: 'Orientation gets its own tab on My Team — weekly attendance tally, drill-down and PDF export', type: 'Feature', sp: 5, done: true, sprint: 'S27' , priority: 'Medium' },
  // 2 SP. NOTE the commit message says ATTESTATION and the commit contains no attestation code at
  // all — clustered by file overlap, it is the Payroll Wizard step rail. The wizard loaders cannot
  // report progress (a fetch either is or is not done), so a determinate bar has to be PREDICTED
  // from that step own load history in localStorage. Extracted into `step-load-prediction` so the
  // one invariant that matters is proven rather than asserted: the bar NEVER reaches 100% on
  // prediction alone, because the line exists to tell Accounting when the figures are safe to read
  // and a bar that hit 100% early would say so early. 12 tests. Not 3: one module and one rail, no
  // data path. Not 1: a real invariant with a test file, and 250 lines of wizard change.
  { epic: 'HRIS-02a', name: 'Payroll Wizard step rail shows a predicted load bar that never reaches 100% on prediction alone', type: 'Feature', sp: 2, done: true, sprint: 'S27' , priority: 'Low' },
  // 5 SP: a person moved mid-week now has "Lead Gen to HSL" printed under the Department line on
  // EVERY paystub surface — app, email, export, PDF. This is the common case, not an edge case: 277
  // of 281 dated transfers are effective on a non-Sunday. Source is `department_transfer_requests`
  // and NEVER the proration block, because a same-rate move prorates nothing and those are exactly
  // the people the label exists for; `applied` rows only, deliberately narrower than the premium
  // map. STAGED into the payload rather than derived at render, because paid stubs are frozen
  // as-paid and a transfer released next month must not rewrite a statement already in an inbox —
  // so already-paid stubs never gain the label, by design. The label is derived ON THE VIEW, which
  // is the fix for the failure this area suffered twice (weekend rows and the proration chip both
  // shipped in-app while the email stayed stale); a parity test pins both surfaces to one string.
  // Not 8: it prices nothing. Not 3: a 253-line tested legs model with round-trip collapsing, two
  // API routes and six paystub modules touched.
  { epic: 'HRIS-03b', name: 'A mid-week department transfer says so under the Department line on every paystub surface', type: 'Feature', sp: 5, done: true, sprint: 'S27' , priority: 'High' },
  // 3 SP, High: `sheet_synced = true` did not mean the Google Sheet was written. When the DB row
  // already held the target department the sheet write was SKIPPED entirely and success was recorded
  // from the DB result — 197 of the last 200 applied transfers claimed success and at least 7
  // provably never landed, which then broke roster visibility for people who were still being paid.
  // The write is now ALWAYS attempted, and the result is three distinguishable outcomes instead of
  // one boolean — cell flipped, already target, or real drift — with a pure tested core pinning them
  // apart. Do not collapse them back into one flag. Not 2: the false-success branch corrupted a
  // downstream identity key. Not 5: one write path and its outcome type. The DATA repair is a
  // separate, un-run step and is NOT claimed by this row.
  { epic: 'HRIS-26', name: 'sheet_synced was a false success — the sheet write is always attempted and reports three outcomes', type: 'Bug', sp: 3, done: true, sprint: 'S27' , priority: 'High' },
  // 3 SP, High: the dispatch VALUES were already correct — 1,040 of 1,040 staged payees priced by
  // the wizard, measured, not assumed — but the EXPORTS hid money in two ways. The pending CSV had
  // no Other Bonuses and no Adjustment column, so "Bonus Total minus PAB minus Tech" was a residual
  // mixing earned money with Accounting signed withholding (694 rows carrying ₱1.83M of other, 86
  // with an Adjustment, 6 of them negative, and 67 where the residual was unsplittable by
  // arithmetic). And all five log views RENDER COP Value and System Bonus while neither was in the
  // export, hiding ₱5.5M of frozen system bonus across 1,606 records. Two identities are now pinned
  // by test. Not 2: these files are the HRIS-vs-Sheet validation artifact, and a column that
  // vanishes between screen and file reads as "we did not pay that". Not 5: no value changed.
  { epic: 'HRIS-03a', name: 'Dispatch exports carry the Adjustment, COP Value and System Bonus they were hiding', type: 'Bug', sp: 3, done: true, sprint: 'S27' , priority: 'High' },
  // ── Sprint 27 · the external steps split out of the two rows above, so closing them buries nothing
  // 1 SP: the SECOND layer of the orientation-email gate. The server-side `isLeadGenDepartment` check
  // ships and is tested, so the hole is closed without this — but the live n8n flow is still
  // Webhook to Split Out to Gmail with no filter, which is the exact shape that let an HSL hire get
  // the Zoom link on 2026-08-21. references/n8n/orientation-email-leadgen-only.json exists in the
  // repo and has never been imported. Split out of the gate row rather than blocking it, because the
  // gate row's claim is about the sender and Kane has confirmed the sender works. 1 SP: an import,
  // not a build.
  // CLOSED 2026-08-28 on Kane's direct confirmation ("Import Orientation Email leadgen mark it as
  // Done"). NOT measurable from this repo — the filter lives inside the n8n cloud workflow and there
  // is no API here to read it, so his word is the evidence and `dateBasis: 'external'` is the honest
  // shape. That is the same exemption the 08-14 n8n-paystub rows took, and it is NOT the blanket the
  // honesty gate forbids: he named this row specifically, unprompted.
  { epic: 'HRIS-24', name: 'Import orientation-email-leadgen-only.json into live n8n as the second-layer filter', type: 'Chore', sp: 1, done: true, sprint: 'S27', priority: 'Medium' },
  // 3 SP, High: the DATA half of the sheet_synced false-success bug. The code fix stops NEW drift;
  // it repairs nothing already drifted. Measured 2026-08-25 across 1,592 sheet rows and 2,564 DB
  // rows: 1,583 agree, 9 drift, 6 of them repairable. Those 9 stale cells are why people who are
  // still being paid fall out of active_employees and go invisible across the app. THE ORDER IS NOT
  // OPTIONAL — flip the Sheet cell to the DB department, re-stamp, and only THEN sync; clicking Sync
  // first would mint 9 duplicate rows in pre-transfer departments and clobber HRIS truth for exactly
  // the invisible people. scripts/fix-sheet-dept-drift.mts does the first two (dry-run default,
  // --apply gate, backup written first) and REFUSES three classes rather than guessing: an
  // off_boarded_at stamp anywhere, DB rows disagreeing with each other, and a DB department that is
  // not placeable. 3 SP: a gated data repair on live payroll identity, not a script run.
  // CLOSED 2026-08-28, and closed on a MEASUREMENT rather than the assertion that prompted it. Kane
  // said it was done; re-running the detection half of fix-sheet-dept-drift.mts (dry-run, read-only)
  // against the live Sheet and DB returned "DRIFT: 3 rows (0 repairable, 3 to escalate) — nothing
  // repairable — done", against 9 rows / 6 repairable when it was measured on 2026-08-25. All six
  // repairable cells are repaired. The three that remain are the exact classes the script REFUSES by
  // design rather than guessing: shainan@ (DB dept is bare `hsl`, not a placeable label), beao@ and
  // ellainnec@ (both carry an off_boarded_at stamp — active-vs-offboarded is a business call). They
  // are escalations, never in this row's scope, and they want their own row if anyone wants them
  // fixed. See the note above: running a plain sync instead of the script would have been actively
  // harmful, and the 0-repairable result is evidence the correct order was followed.
  { epic: 'HRIS-26', name: 'Repair the 9 drifted master-sheet department cells left behind by the sheet_synced false success', type: 'Chore', sp: 3, done: true, sprint: 'S27', priority: 'High' },
  // ── Pass 14 · 2026-08-26 · the three commits the 08-25 pass could not have covered ────────────
  // All three are on LOCAL main only (origin/main is at 667dfe9d), so all three are In Progress and
  // none carries an Actual SP. That is the honesty gate doing its job, not a scoring opinion.
  //
  // 2 SP: the 08-24 rebrand pointed all three processor registries at /kolan.png and never added the
  // asset, so Kolan — the highest-volume rail — rendered the fallback orange monogram on every screen
  // for a day with nothing erroring. ProcessorLogo's onError fallback is what made that survivable
  // and also what made it invisible: a referenced-but-absent logo looks exactly like a card that was
  // never given one. Deliberately its OWN row rather than folded into the Done rename row — that row
  // claims shipped-and-proven, and this is the surface it shipped broken. Scored 2, not 1: logoSrc
  // turned out to have six consumers, one of them carrying a mix-blend-multiply banned by
  // ui-standards 6.4 that flattened the new mark to a black square in light mode only; and it added
  // processor-logo-assets.test.ts, which pins what the docs asserted and nothing enforced (every
  // logoSrc resolves to a real file), all three assertions confirmed failing before being left green.
  { epic: 'HRIS-03a', name: 'Kolan showed a fallback monogram for a day because /kolan.png was referenced and never existed', type: 'Bug', sp: 2, done: true, sprint: 'S27', priority: 'Medium' },
  // 3 SP: the 08-25 board pass itself. Asked to fix completion dates, it MEASURED first and found
  // that half already true — 0 Done rows without a date across all 188 — and found the real gap
  // elsewhere: twelve shipped features had no row at all. 14 rows created, 12 Done, 40 SP, VERIFY
  // PASS 202/202. Two closures were refused on evidence rather than on a blanket confirmation, and
  // both refusals are the reusable part: a confirmation cannot push a commit (1f94ff70 was still not
  // an ancestor of origin/main, re-fetched twice), and an assertion cannot run a migration (the Kolan
  // rename was probed read-only instead — payout_brand returns rows, a negative control on the same
  // table returns 42703, which is what proves the probe can detect absence). Tooling half: TaskPriority
  // modelled two labels while the board carries four, so every row below High was silently unlabelled
  // — extended to Critical/High/Medium/Low, an ADDITION to what the reconciler can write.
  { epic: 'HRIS-15', name: 'Board sync closed twelve undeclared features and refused one closure a measurement disproved', type: 'Chore', sp: 3, done: true, sprint: 'S27', priority: 'Medium' },
  // 3 SP: two documentation passes, 08-25 and 08-26, collapsed into one row on file overlap — both
  // are session logs plus the doc gaps reading them exposed. The 08-25 pass wrote the 15-session log
  // and closed two undocumented surfaces (the wizard step-load rail; the pay-structure natural-key
  // upsert, 714 structures). The 08-26 pass logged what that one missed, corrected an entry it got
  // wrong — it recorded a CONCURRENT session as having ended when that session was eleven minutes
  // from committing 40 SP of board work — and fixed two indexes that were silently dropping entries:
  // MEMORY.md had passed its ~24.4KB load cap and was being TRUNCATED, so entries below the cut were
  // invisible to every session (47 hooks rewritten, all 193 entries kept, 0 broken links, 0 orphans),
  // and docs/README.md had drifted 22 feature docs behind docs/features/, including the board-sync
  // doc that shipped the day before. Not a feature, and logged anyway: the governing docs are what
  // hardening and blueprint read at step 1, so an index that drops entries is a gap in every later
  // decision.
  { epic: 'HRIS-15', name: 'Two documentation passes, and the two indexes that were silently dropping entries', type: 'Chore', sp: 3, done: true, sprint: 'S27', priority: 'Medium' },
  // ── Pass 15 · 2026-08-26 · three features that landed AFTER pass 14 was staged ────────────────
  // Pass 14 was staged at 09:18 with AUDIT_RANGE 1f94ff70..HEAD and 4 commits. Three more landed the
  // same day, two of them after that snapshot, so they were undeclared for the same reason the last
  // twelve were: nothing re-reads a staged range.
  //
  // 5 SP: the HR half of orientation attendance. The MANAGER tab shipped earlier at 5 SP and this is
  // its peer, not its echo — 13 files, 1,820 insertions, a new route, a new tested module
  // (orientation-week-stats.ts, 236 lines, 337 of test) and a 570-line panel. The load-bearing
  // distinction it encodes is that LISTED is not STAGED: the roster names who was expected, the rate
  // is computed against who was actually STAGED, and a week where nothing was marked renders as a
  // NOTE rather than 0% — a 0% that means "nobody recorded it" is a lie about attendance. Week
  // buckets follow the HR period_start, not the manager tab's own week, and one cached fetch serves
  // every week. Not 8: no money path, no rate, no dispatch row. Not 3: a new route, a new tested
  // module and a new inner tab on a live HR screen.
  { epic: 'HRIS-24', name: 'Orientation gets its own tab on the HR New Hire Checklist — listed vs attended, per week', type: 'Feature', sp: 5, done: true, sprint: 'S27', priority: 'Medium' },
  // 2 SP: 833 pending dispatch rows exported with NO payout destination. The exporter's detailFields
  // covered some rails and silently omitted Kolan and HiGlobe, so a clerk received a file naming who
  // to pay and not where — the worst shape for an export, because it looks complete. The fix is small
  // (35 lines) and the guard is the point: detailFields coverage is now a TEST, so a rail added
  // without a destination fails at build rather than at the bank. Not 3: no pricing, no new surface,
  // one exporter. Not 1: it is a money-adjacent omission on a live Accounting artefact.
  { epic: 'HRIS-03a', name: 'Dispatch exports carried 833 pending rows with no payout destination', type: 'Bug', sp: 2, done: true, sprint: 'S27', priority: 'High' },
  // 3 SP: exported pay stubs head themselves with the department the roster holds TODAY, marked
  // "(current)", on every week the export covers — paid, staged or reconstructed. Does NOT contradict
  // "a paid stub is frozen": the money and the per-week record are untouched, and the in-week moves
  // keep being explained by the per-week Department Change column. One server-side resolution
  // (getEmployeeMasterRecord) feeds all three export call sites, and the fallback is a STATE not a
  // mask — a null current department is real (an off-boarded person has no active master row), so it
  // falls back to the newest week's own department and deliberately omits "(current)". Both sides go
  // through formatDeptLabel so a raw hsl:* key can never reach a header; a test pins it. Not 5: one
  // pure function and three call sites, no money path. Not 2: 164 lines of test and a deliberate
  // ruling about what freezing does and does not cover.

  { epic: 'HRIS-03b', name: 'Exported pay stubs name the CURRENT department, paid or not', type: 'Feature', sp: 3, done: true, sprint: 'S27', priority: 'Medium' },
  // ── Pass 16 · 2026-08-27 · the tool that declares the board was never declared ON it ─────────────
  // Kane: "add this skill to our Monday board". HRIS-15 already carries a 3-SP Chore row for each
  // board-sync PASS and one for the approval-gate fix, but the SKILL ITSELF — the thing every one of
  // those passes ran through — has no row. Sixteen passes have been credited and the tooling has
  // not. Found while flagging undeclared work at the end of the 08-27 flush, which is the same class
  // of gap the last three passes each found in the product.
  //
  // TWO rows, clustered on FILE OVERLAP and not on the sixteen-day commit stream between them: the
  // build (520a7755) and the ledger (7e39a599) share almost no files, are ten days apart, and the
  // second is a capability the first deliberately did not have.
  //
  // 5 SP: the build. 15 files, 1,837 insertions — SKILL.md, eight scripts, the governing doc, and
  // the hook into this file. Scored as the exact peer of the 5-SP Payroll Wizard manual-validation
  // row (13 files, ~1,750 lines, a new route plus a tested module): comparable mass, comparable
  // novelty, no money path. Not 8 — every 8-SP row on this board moves a rate, a dispatch row or a
  // score component, and this moves none; it is dev tooling. Not 3 — the three existing board-sync
  // Chore rows at 3 SP are single PASSES, and this is the machine they all run on. What it actually
  // encodes: items match BYTE-EXACT so a normalised name orphans a row forever, the reconciler and
  // the corrector own DISJOINT column sets with a runtime assertion proving it, and no write happens
  // without an approval hash bound to the proposal Kane was shown.
  { epic: 'HRIS-15', name: 'The Monday board gets a writer that cannot lie — the board-sync skill, its approval gate and the two-writer column split', type: 'Chore', sp: 5, done: true, sprint: 'S26', priority: 'Medium' },
  // 3 SP: the ledger. 8 files, 634 insertions, two new modules (pending-sp.mts 251, flush-pending.mts
  // 169). Before it, a pass that exhausted the daily API budget mid-corrections silently DROPPED its
  // tail — the run ended, the rows were never written, and the SP was recoverable only by re-deriving
  // the whole pass from git. Now the budget death queues what it could not write, and a later flush
  // completes it on the SAME approval hash, which is the entire justification for a one-command
  // flush not being a hole in the approval gate. What a delay can invalidate is re-checked at flush
  // time by revalidate(), which refuses on any of seven conditions — no hash, re-scored since
  // queueing, name no longer byte-exact in the plan, Done with no date or an open blocker, a
  // Completed Date that no longer matches its last sha, or a sha git cannot resolve or that has left
  // origin/main. Not 5: two modules and a hook, no new surface and no money path. Not 2: the seven
  // refusals were each verified against a synthetic entry, and the gate is what keeps a deferred
  // write honest. PROVEN IN PRODUCTION 2026-08-27, hours before this row was written: it flushed
  // 9 owed rows / 33 SP under hash 7378e56e5902, 0 refused, and all 9 were confirmed by re-read.
  { epic: 'HRIS-15', name: 'A dead API budget owes the SP instead of losing it — the pending-SP ledger and its seven refusals', type: 'Chore', sp: 3, done: true, sprint: 'S27', priority: 'Medium' },

  // ── PASS 18 · 2026-08-28 — the undeclared fortnight, 10 rows / 45 SP ────────────────────────────
  // Kane: "Update our Monday board with all our withheld and Undeclared SP right now!", then, mid-pass,
  // "check previous claude sessions it has data also make sure git commits". That second instruction is
  // what makes this pass different from the last three: the SESSION TRANSCRIPTS were read alongside the
  // commits, and it is the only reason rows 2 and 9 below are two rows instead of one.
  //
  // WITHHELD: pending-sp.json reads 9 entries / 0 unflushed — the 2026-08-27 flush cleared all 33 SP it
  // owed, so nothing is withheld in the ledger. The one genuinely withheld row is the 5-SP Tickets
  // notification row, still Pending Deploy on a blocker RE-MEASURED TODAY against the live
  // webhooks.config: 22 slugs configured, ticket_created / ticket_assigned / ticket_done all present and
  // active, ticket_replied and ticket_moved ABSENT. The email leg still no-ops, so it stays held.
  //
  // DONE ON A RECORDED CONFIRMATION. Asked in this pass's review which of the nine product rows he had
  // looked at in production, Kane answered "All nine — I've tested everything". That answer is the
  // evidence and it is written here rather than assumed. Applying it across all nine is safe in a way
  // the same blanket was NOT on 2026-08-26 — when the Tickets row was held back from it — because every
  // migration these rows depend on was PROBED APPLIED first, with a passing negative control. No row
  // here closes over an open external step that an assertion could not have closed.

  // 5 SP. d81ffecc + 23c45325 + 850fdf22, one row on file overlap: all three touch SchedulingPanel and
  // the two lib modules. 11 files, 1,880 insertions, 24 tests across two pure modules. UI ONLY, on
  // Kane's explicit instruction — no route, no table, no migration; edits live in React state and a
  // permanent banner says so. Peer of the 5-SP "Orientation gets its own tab on My Team": same class of
  // surface, more pure logic, no real data behind it. Not 8 — nothing here feeds pay, and wiring a
  // schedule into a pay rule is deliberately left undone. Not 3 — both modules exist to close named
  // failure classes: the unit is a PERIOD and never a field on a person, isScheduledDay returns
  // boolean|null because "no schedule on file" is not "scheduled to rest", and parseShiftWindow REFUSES
  // a half-qualified time rather than inferring one.
  { epic: 'HRIS-10', name: 'Manager Scheduling tab — schedule periods with a rest-day model, UI first and no backend', type: 'Feature', sp: 5, done: true, sprint: 'S27', priority: 'Medium' },
  // 2 SP. Lives inside cd681cf8, whose commit message is the single word "Offboarded" and which contains
  // NO offboarding code at all — it carries the MESA rebuild below AND this, written in a different
  // session. Split on file overlap: this row owns PayStubModal.tsx, PayrollDispatch.tsx and
  // payroll-wizard-manual-validation.md; MESA owns src/lib/mesa/* and the migration. ~177 real lines.
  // The dispatch log leaves the bottom of the statement for a right-hand accounting rail, the statement
  // centres, and the manual-validation vouch joins that rail — keyed on the WORK email (QueueRow.id)
  // with NO fallback to the payout address, because personal addresses are shared and recycled in the
  // master list and an alias match would surface a vouch belonging to a different person. Display-only,
  // omitted on every employee-facing mount, reading the one useManualValidations hook. Peer of the 2-SP
  // Kolan monogram row: one surface, no money path, a single correctness rule worth pinning.
  { epic: 'HRIS-03a', name: 'View Paystub gets an accounting rail — the dispatch log moves right and the manual-validation vouch joins it', type: 'Feature', sp: 2, done: true, sprint: 'S27', priority: 'Medium' },
  // 5 SP. a9901284, 13 files, 1,006 insertions. NOT a re-assertion of the 5-SP "Time adjustments need
  // two sign-offs" row from 08-19 — this is Kane REOPENING both of that build's rulings on 08-27. The
  // approver pool is now the department of whoever FILED the request, not the union of the manager's
  // departments, and resolveAdjustmentDepartment feeds both the pool and the manager's authorization
  // check, so the picker can never offer someone the guard would then refuse. Naming an approver grants
  // a seat that is DERIVED, never stored: no employee_roles write, no employee_feature_permissions row,
  // no bumpForceLogoutFor — the approver reviews from a new employee-portal Approvals tab (349 lines)
  // and never loads the Manager dashboard, so every excluded manager power is unreachable rather than
  // merely hidden, and a recall makes the seat vanish with nothing to revoke. second_approve and
  // second_deny dropped the manager:time_adjustments grant and authorize on the on-row assignment alone,
  // which is a NARROWING. Peer of the 5-SP manual-validation and mid-week-transfer rows: a new route, a
  // new surface, a tested module, no money moved.
  { epic: 'HRIS-04', name: 'The second approver comes from the request’s own team, and naming one grants a derived portal-only seat', type: 'Feature', sp: 5, done: true, sprint: 'S27', priority: 'High' },
  // 5 SP. a73948a1, 12 files, 668 insertions. A money-path divergence, not a display bug:
  // member-monthly-pay scored HSL PAB Mon→Sun while dispatch PAID Sun→Sat, so
  // /api/manager/member-monthly-pay contradicted what actually paid. Root cause was two helpers with a
  // legacy default and five callers that never passed it — checkHslPabEligibility and getHslAdjustedEnd
  // defaulted weekModel to 'mon_sun', and buildCalendarMonthWeeksIncludingWeekends defaulted
  // startOnSunday to false under a comment that was true when written and inverted by the 2026-05-31
  // cutover. All three are now REQUIRED parameters, pinned by a @ts-expect-error case: there is no safe
  // default for a value whose correct answer changes on a date. The grid moved and the money did not —
  // non-HSL PAB is still won Mon–Fri, the new weekend cells are scoring:false, and an identity test
  // asserts the Sun–Sat grid's scoring cells are EXACTLY the old builder's, so a failure there means
  // non-HSL PAB money has moved. Peer of the 5-SP HSL OT-rate arrears row. Not 8 — no rate moved and no
  // arrears were owed; the contradiction was caught before it priced a cycle.
  { epic: 'HRIS-02b', name: 'Every PAB calendar reads Sun–Sat — the week model becomes a required argument, not a default', type: 'Bug', sp: 5, done: true, sprint: 'S27', priority: 'High' },
  // 2 SP. c229a2b8, 6 files, 385 insertions of which 304 are the test. payment-dispatch.md 3.3.1 had
  // banned the Kolan lockup outright because the official asset's wordmark is white on a plate that is
  // bg-white in both themes — a real hazard, but a property of that FILE, not of lockups. So the
  // prohibition became a MEASUREMENT rather than being dropped: this asset is 96.5% of its opaque ink
  // below luminance 128, and processor-logo-assets.test.ts decodes the PNG with node's own zlib (no new
  // dependency — sharp is only a transitive Next package) and rejects ink under 90% dark, canvas aspect
  // under 1.5, or ink-to-canvas width under 80%. Proven to bite, not merely asserted: a synthetically
  // inverted copy measures 3.5% dark and an over-padded canvas 30% ink width. The one general rule
  // added: every logoSrc must match the on-disk filename CASE-EXACTLY, because Windows and macOS both
  // resolve the wrong case and Linux static serving does not — a case slip renders locally and 404s in
  // production, which is the 2026-08-24 phantom-/kolan.png failure exactly. Peer of that 2-SP row.
  { epic: 'HRIS-03a', name: 'Kolan’s plated dispatch card takes the dark lockup, with the mark-only rule retired on a measurement', type: 'Feature', sp: 2, done: true, sprint: 'S27', priority: 'Medium' },
  // 5 SP. a366c067, 12 files. The 63k insertion count is the source JSON; the real change is ~1,200
  // lines. "Offboarded by HRIS" and "Offboarded" were never two populations — /api/hr/offboard writes
  // BOTH offboarding_queue and offboarded_sheet, so all 488/488 completed queue rows already sat in the
  // ledger and the HRIS tab contributed ZERO people. It is now the Origin filter on one list. Origin is
  // a STORED column (NOT NULL DEFAULT 'hris', CHECK, index) and had to be: the old tell —
  // off_boarded_by IS NULL — was an accident of the 08-07 retirement that the import below breaks by
  // construction, since an imported row is written today with no actor. MIGRATION PROBED APPLIED
  // 2026-08-28 with a passing negative control: offboarded_sheet.origin exists, 492 hris / 3,519
  // google_sheet, 4,011 rows total — so the 165-row backfill landed too. That backfill does not reopen
  // the spreadsheet: the retired sync was dangerous for being RECURRING and REPLACING, and this is
  // neither, enforced not intended — manual --apply gate, INSERT-ONLY, skips anyone already on the
  // ledger, and exits non-zero if franm@ (the exact cell the sync was retired over) would ever be
  // re-inserted over her hand-correction. Peer of the 5-SP Payroll Notes Offboarded tab. Not 8 — no
  // money moved, and the four keep-toward catalog guards that see these rows were left untouched.
  { epic: 'HRIS-01a', name: 'HR Offboarding is one Offboarded tab with a stored origin column and an insert-only JSON backfill', type: 'Feature', sp: 5, done: true, sprint: 'S27', priority: 'Medium' },
  // 5 SP. 9a42f5f2 + bb4b2311 + 1b262488 + 4b8f7177, one row on file overlap — all four are
  // PayrollWizard.tsx plus the wizard docs, and one row must describe the CURRENT rule rather than the
  // iterations that reached it. HSL and Additions are now a single step 4; the HSL case body moved
  // VERBATIM into renderHslWorkspace (773 lines, proven byte-identical) and HSL is a TAB inside
  // Additions, never a row in the shared department table — it prices Mon–Sun weeks with a weekend
  // premium and takes its bonuses from HSL KPI periods, so its rows do not fit the other departments'
  // columns. RENUMBERING WAS FORCED, not cosmetic: the rail's progress is currentStep / steps.length and
  // completion is currentStep >= steps.length, so an id gap would read past 100% and mark Reports
  // complete while standing on Dispatch. Both real gates moved with their numbers, unchanged in
  // substance — the red-flag confirm at 6 and the FX-zero dispatch block at 7. Nothing was loosened to
  // fit. No figure, column, total, handler or stored value changed, which is what makes this a render
  // change and not a money change. Peer of the 5-SP wizard rows; not 8 — the 8-SP Tutorial Mode row
  // built a new surface, and this restructures an existing one.
  { epic: 'HRIS-02a', name: 'Payroll Wizard: HSL and Additions become one step, HSL keeps its own tab, and the rail renumbers 1-8', type: 'Feature', sp: 5, done: true, sprint: 'S27', priority: 'Medium' },
  // 5 SP. 3fb27b1d, 29 files, 1,832 insertions, four pure tested modules. Draw stays the default and
  // Type sits beside it, and the result is the SAME artifact drawing produces — a trimmed transparent
  // PNG into the same document_signatures.image_data_url. Zero backend: no migration, no route change,
  // nothing downstream can tell the two apart. The pointer bug was the DIALOG, not the pad: SignaturePad
  // sized its bitmap from getBoundingClientRect() on mount inside a dialog animating in with
  // zoom-in-[0.94], so it measured a TRANSFORMED box and ink landed ~6% of the pad width off at the
  // right edge while being exact at the left. ResizeObserver cannot catch it — a CSS transform does not
  // change the layout box it observes. Three guards, each because the failure it prevents is SILENT:
  // faces are self-hosted and gated on document.fonts.load() AND check(), because Canvas 2D does not
  // report a missing font and a CDN miss would save a signature that simply is not cursive; coverage is
  // checked per face, so Homemade Apple refuses rather than printing .notdef on a bank document; and the
  // raster is sized against the PDF, not the screen, because both renderers scale-to-fit and never
  // upscale. Found en route: the COE one-page tests embedded a 1x1 PNG rendering 1pt tall — 45pt of
  // slack production never has, on the element that decides the page count. Not 3 (the Documents queue
  // rebuild) — this adds a capture mode AND root-causes a rendering bug. Not 8 — no money, no backend.
  { epic: 'HRIS-18', name: 'A signature can be typed as well as drawn, and the pointer finally lands on the ink', type: 'Feature', sp: 5, done: true, sprint: 'S27', priority: 'Medium' },
  // 8 SP, and the only 8 in this pass. The other half of cd681cf8 (see the accounting-rail row above for
  // the split): 17 files, src/lib/mesa/* plus the migration, the CSV and three scripts. It qualifies on
  // the board's own 8-SP profile — every 8-SP row here moves a rate, a dispatch row or a score component
  // — because it rebuilt a LIVE ledger: 9,883 rows and 280 accounts written to production, 143 stale
  // mesa_member flags cleared, 1,738 rate rows stamped. PROBED TODAY: mesa_ledger 9,883, mesa_accounts
  // 280, mesa_request_receipts.amount_php and mesa_payroll_obligations both present — migration APPLIED,
  // every figure matching the independent verify script, which recomputes from the CSV rather than
  // trusting the writer's helpers. The ruling underneath is Kane's and decides every balance: a
  // withdrawal is SPENT, not a loan — receipts worth at least the amount requested mean nothing is owed,
  // and only a shortfall returns. Reading the CSV's Payback columns as loan repayments instead would
  // have swung open balances by ₱788,383. The first apply wrote 9,915 rows with 36 discrepancies from
  // two deposit-bounds bugs, so the invariant that every deposit falls inside [opened_on, closed_on] is
  // now enforced in pre-flight, and the writer refuses to write on ANY validation problem after an
  // earlier run deleted before validating and left the ledger half-built. Also ships the server-enforced
  // disbursement guard (16 tests) that fails CLOSED with 503 on a ledger read error and subtracts
  // pending draws, so two withdrawals that each fit cannot together overdraw.
  { epic: 'HRIS-07', name: 'MESA rebuilt from the CSV on the receipt-shortfall ruling, with a server-enforced disbursement guard', type: 'Feature', sp: 8, done: true, sprint: 'S27', priority: 'High' },
  // 3 SP. 5120398d + 00eefbd8 + 606cd61e, one row on file overlap — all three touch CLAUDE.md and
  // docs/features/INDEX.md, they landed the same day, and the pair is a SINGLE governing rule that only
  // makes sense whole: before writing code, use blueprint if the thing does not exist yet and hardening
  // if it does. ~300 lines of SKILL.md plus the CLAUDE.md routing rule. blueprint scopes a new surface
  // against the governing docs and the nearest shipped precedent, posts a brief and HARD-STOPS for
  // approval before any code is written, then writes the feature doc, the INDEX row and the memory entry
  // into the same commit. hardening reads the governing docs FIRST, cites the rules it found, stops on a
  // contradiction instead of picking a side, and forbids fixing anything by loosening a type, guard,
  // validation, limit or test. Peer of the 3-SP board-sync ledger row: process tooling, no deployed
  // surface. Not 5 — the board-sync build was 15 files and eight scripts; this is two SKILL.md files.
  // DONE ON USE, not on a click-through, exactly as the two board-sync rows closed in pass 17: this is
  // local tooling with no deployed surface, so that gate does not map and is not pretended to. The
  // evidence is that both have been RUN and left records — manager-scheduling-ui-first names the
  // blueprint run that split Workforce Coverage into three surfaces, hardening-skill-and-open-gaps names
  // a hardening run, and two separate sessions on 2026-08-28 entered blueprint before writing any code.
  { epic: 'HRIS-15', name: 'The blueprint and hardening skills — every code change routes through one of them before it is written', type: 'Chore', sp: 3, done: true, sprint: 'S26', priority: 'Medium' },
  // ── PASS 21 · 2026-09-01 · the range 6ae82ac5..bf43c86a (48 commits, Aug 28 pm – Sep 1) ────────
  // Clustered by FILE OVERLAP, not message — this range carries the trap's best specimen yet:
  // e8e8c6ae says "PAB TAB Ignore" and contains ZERO PAB files; it is the entire Termination
  // Documents feature (4 API routes, the panel, its migration and three plan docs). Sprint split is
  // by Completed Date against the windows: Aug 28-31 → S27 (its attribution absorbs the Aug 30-31
  // gap days), Sep 1 → S28.
  //
  // 5 SP: twelve commits on one surface in one afternoon. The step said "nobody is ineligible" over
  // 1,557 ineligible people (the diagnose script measured it); the fix, then the table earns the
  // surface: names not emails, Employee ID + work email columns, department + status filters reading
  // the Payment Catalog (not raw keys), a KPI strip, coverage pinned to active GML people WITH hours,
  // a leaver-with-no-hours no longer ranked worst attendance, an eligible count with checkable
  // arithmetic, and the calendar modal gone wide with the verdict in a right rail. Not 8: one step,
  // no new table, no money path — the verdict semantics shipped separately (the S28 row).
  { epic: 'HRIS-02b', name: 'PAB step shows the 1,557 people it hid — names, Employee IDs, Catalog departments, status filters and a KPI strip', type: 'Feature', sp: 5, done: true, sprint: 'S27', priority: 'High' },
  // 2 SP: the HSL wizard step loses its banner and the weekly KPI period cards (hand-keyed monthly
  // cards STAY, per the hsl-monthly-bonus-cards-only rule). One commit, chrome not calculation.
  { epic: 'HRIS-02a', name: 'Wizard HSL step drops the banner and the weekly KPI period cards', type: 'Feature', sp: 2, done: true, sprint: 'S27', priority: 'Low' },
  // 1 SP: the missing-CSV dialog claimed an auto-sync that does not exist; it now says less and
  // stops lying. A truthfulness fix in one component.
  { epic: 'HRIS-02a', name: 'Missing-CSV dialog stops claiming an auto-sync it never performs', type: 'Bug', sp: 1, done: true, sprint: 'S27', priority: 'Low' },
  // 2 SP: a new rankings-viewers RBAC module with tests — the Rankings tier flags are kaner@ alone,
  // and being an admin confers nothing (the tickets-dedicated-role-only shape, applied to rankings).
  { epic: 'HRIS-09', name: 'Team Rankings is Kane’s alone — admin roles confer nothing', type: 'Feature', sp: 2, done: true, sprint: 'S27', priority: 'Medium' },
  // 2 SP, one row on file overlap (both touch hsl-catalog-migration.md + INDEX.md, two days apart,
  // one story): the docs sweep found a RED double-pay guard; the follow-up proved the guard was
  // RIGHT and the TEST was wrong, and fixed the test — the guard itself never moved. Also wrote the
  // salaried-pay-basis and pay-structure-no-department docs plus an audit script.
  { epic: 'HRIS-06', name: 'The red double-pay guard was right — its test was wrong, and three undocumented surfaces got their docs', type: 'Bug', sp: 2, done: true, sprint: 'S27', priority: 'Medium' },
  // 5 SP: THE 1:1 RULE — the receiving bank drives the send-from rail, superseding the 08-31 wires
  // lock. Three commits rewriting the same tested modules (employee-payment-processors,
  // wallet-rail-lock): pickers judge the EFFECTIVE rail not tier 1, the RECEIVING side is gated with
  // the coupling one-way, then the rule lands across profile, People, approvals and the OTP form.
  // Peer of the 5-SP Kolan/HiGlobe assignability row: who can be routed where, on the rail.
  { epic: 'HRIS-19', name: 'The 1:1 rule — the receiving bank drives the send-from rail, gated on both sides', type: 'Feature', sp: 5, done: true, sprint: 'S27', priority: 'High' },
  // 2 SP: Start Processing stopped being synthesized (the "every cue is Web Audio" rule died here) —
  // a real engine recording, truckstart.mp3, plays in both the Wizard and Dispatch, with a tail
  // fade and a sound-tester bench that auditioned three candidates without touching the shipped cue.
  { epic: 'HRIS-02a', name: 'Start Processing plays a real engine — truckstart.mp3 in both the Wizard and Dispatch', type: 'Feature', sp: 2, done: true, sprint: 'S28', priority: 'Low' },
  // 2 SP: Preview Emails leaves the stock dialog for the wizard's chrome and shows the WORK email —
  // display only, delivery still goes to the personal address (preview-emails-work-email rule).
  { epic: 'HRIS-03b', name: 'Preview Emails wears the wizard’s chrome and shows the WORK email', type: 'Feature', sp: 2, done: true, sprint: 'S28', priority: 'Low' },
  // 5 SP: the verdict layer on top of the S27 table row. The payout week owns the tab (the
  // pab-payout-week gate), Ignore joins Forgive as the other verdict, decided rows LEAVE the list
  // into a Done tab of receipts with realtime decisions across open wizards, paused departments skip
  // the step, HSL failures aggregate as weeks, a no-hours day reads amber never grey, confirms use
  // the app's dialog, and PAB moves BEFORE Additions — the rail is 4 PAB, 5 Additions, 6 Contractors.
  // Not 8: no new table — decisions ride the existing exclusions path; the surface was the S27 row.
  { epic: 'HRIS-02b', name: 'PAB verdicts — the payout week owns the tab, Ignore joins Forgive, decided rows leave to a realtime Done tab, and PAB becomes step 4', type: 'Feature', sp: 5, done: true, sprint: 'S28', priority: 'High' },
  // 3 SP: a No Pay Rate readiness row can be Ignored for exactly one week, backed by a NEW
  // payroll_rate_exemptions table (migration MEASURED APPLIED 2026-09-01 — the table exists and
  // already holds a row), an API route, a tested readiness-rate-ignore module, and the FAB wiring.
  { epic: 'HRIS-20', name: 'Readiness No Pay Rate rows can be Ignored for one week, backed by a payroll_rate_exemptions table', type: 'Feature', sp: 3, done: true, sprint: 'S28', priority: 'Medium' },
  // 3 SP: Bank Preferred requests stop being a card above the Issues table and become ROWS in it,
  // the default filter is All with KPI cards always counting ALL data, and decided bank rows gain
  // Edit and Delete — decisions are no longer immutable (a new [id] API route).
  { epic: 'HRIS-19', name: 'Bank Preferred requests are rows in the Issues table, and decided rows gain Edit and Delete', type: 'Feature', sp: 3, done: true, sprint: 'S28', priority: 'Medium' },
  // 5 SP: the People → Offboarded tab becomes a search-first surface (search · pay · bank), with a
  // new API route and a tested offboarded-search module; the one-off payment cards MOVE into the
  // processor buckets on Payment Dispatch; live search console treatment, phase messages, Employee
  // ID column and a typing-only debounce. ROW grain, recycled emails warn-and-allow.
  { epic: 'HRIS-23', name: 'People Offboarded search tab — search · pay · bank in one surface, one-off cards join the processor buckets', type: 'Feature', sp: 5, done: true, sprint: 'S28', priority: 'High' },
  // 5 SP: the Termination Documents surface — its own termination_documents table (migration
  // MEASURED APPLIED 2026-09-01: the table exists and holds a row), four API routes (list, facts,
  // search, per-id), the Accounting panel with a scan-line search where the personal email SEARCHES
  // and the work email IDENTIFIES, undo on the doc row, and a revert-writebacks script. Shipped in
  // e8e8c6ae, whose message — "PAB TAB Ignore" — names a different feature entirely.
  { epic: 'HRIS-18', name: 'Termination Documents — a generated packet per leaver with its own table, personal-email search and undo on the doc row', type: 'Feature', sp: 5, done: true, sprint: 'S28', priority: 'High' },
  // 3 SP, done:false — RE-DERIVED 2026-09-02: 6d16bd70 and 604abd10 (the earlier comment mistyped
  // the second as 604add10) are BOTH ancestors of origin/main now, so the In Progress cap the staged
  // pass wrote has expired and the row is Pending Deploy. It stays done:false — pushed is not
  // confirmed-live, and Done needs a click-through. Generate COE from the Signing Queue: accounting
  // issues the certificate and signs on the employee’s behalf, active-GML-only and failing CLOSED,
  // with the audit naming the ADMIN who generated it.
  { epic: 'HRIS-18', name: 'Generate COE from the Signing Queue — accounting issues and signs on the employee’s behalf', type: 'Feature', sp: 3, done: false, sprint: 'S28', priority: 'Medium' },

  // ── PASS 22 · 2026-09-02 · the range bf43c86a..0703c748 (12 commits, Sep 1 evening) ────────────
  // Everything below is an ancestor of origin/main and NONE of it carries a migration, an apply
  // script or an n8n workflow (checked: the range's diff has no .sql, no apply-*.mjs, no n8n json),
  // so nothing here is code-complete-but-dead. Every row is therefore Pending Deploy and every one
  // is done:false — pushed is not confirmed live, and Done waits on a click-through. Clustered by
  // file overlap: 2547b719 says "ORPHANAGE UI" and touches ZERO orphanage files — it is 1,227 lines
  // of HslBonusCalculator, the second specimen of the message trap in as many passes.
  //
  // 5 SP: two commits on the Orphanage step (shared PayrollWizard.tsx + orphanage-pay-step.md). The
  // additions blob is written under CAS with Restore-from-record on the red panel, and deletes then
  // wipe BOTH carriers — a Remove all button, record-only row deletes, and a snapshot-or-refuse
  // audit. New tested wizard-additions module, a new confirm dialog, and the orphanage-pay-db layer.
  { epic: 'HRIS-03c', name: 'Orphanage step deletes wipe both carriers, the additions blob is written under CAS, and the red panel restores from record', type: 'Feature', sp: 5, done: false, sprint: 'S28', priority: 'High' },
  // 5 SP: the HSL KPI surface rebuilt off the design handoff — branches stop being cards and become
  // a LIST that opens a Windowed/Half/Full overlay, SSD is rebuilt, and the first-load skeleton
  // mirrors the branch list instead of the cards it replaced. Three commits, one component.
  { epic: 'HRIS-30', name: 'HSL KPI branches become a list that opens a Windowed/Half/Full overlay, with SSD rebuilt and a matching first-load skeleton', type: 'Feature', sp: 5, done: false, sprint: 'S28', priority: 'Medium' },
  // 5 SP: a new 439-line kpi-cache module with 418 lines of tests behind both calculators, plus a
  // cache-identity hook — the KPI Calculator paints from cache across the tab-switch unmount and the
  // bonus catalog is cached so Departments is instant. Scoring is HELD until week, catalog and FX
  // are all live, so the cache PAINTS but never DECIDES (the kpi-calculator-tab-cache rule).
  { epic: 'HRIS-06', name: 'KPI Calculator paints from cache across the tab-switch unmount, and holds scoring until week, catalog and FX are live', type: 'Feature', sp: 5, done: false, sprint: 'S28', priority: 'Medium' },
  // 5 SP: the Manager shell gets the same treatment on its own module — a new tab-cache (471 lines,
  // 354 of tests) and a cached-state hook across ManagerApp, Bonus History and Transfers, surviving
  // both the tab-switch unmount and a reload, with the bonus-scoring queue reworked around it.
  { epic: 'HRIS-10', name: 'Manager dashboard shell paints from cache across the tab-switch unmount and a reload', type: 'Feature', sp: 5, done: false, sprint: 'S28', priority: 'Medium' },
  // 2 SP: Payroll Notes rows become shared — any wizard editor may delete or apply any row, not just
  // its author — and the board pages past the PostgREST 1000-row cap that was hiding rows.
  { epic: 'HRIS-21', name: 'Payroll Notes rows are shared — any wizard editor deletes or applies any row, and the board pages past 1000', type: 'Feature', sp: 2, done: false, sprint: 'S28', priority: 'Medium' },
  // 3 SP: a replayed week's export carried a partial split, so rows did not reconcile against the
  // paid final. A new tested replay-finals-overlay module makes a replayed export carry the FULL
  // saved split — the wizard-week-replay-fidelity rule, turned into code.
  { epic: 'HRIS-02a', name: 'Replayed wizard exports carry the FULL saved split, so every row reconciles against the paid final', type: 'Bug', sp: 3, done: false, sprint: 'S28', priority: 'High' },
];
