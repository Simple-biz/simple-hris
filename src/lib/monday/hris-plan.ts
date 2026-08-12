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
  S24: 'group_mm4my9wx',
  S25: 'group_mm4m16sq',
  S26: 'group_mm5s2dw1',
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
export const TASK_SPRINT_INDEX: Record<TaskSprint, number> = { S24: 0, S25: 1, S26: 13, BL: 2 };
/**
 * The live label TEXT for each sprint key. The board is structure-locked — the API cannot create a
 * Sprint label — so a pass must assert these still match `settings_str` before writing. There is no
 * Sprint 27 label yet: when Sprint 26 ends, someone adds it on the board by hand first.
 */
export const TASK_SPRINT_LABELS: Record<TaskSprint, string> = {
  S24: 'Sprint 24',
  S25: 'Sprint 25',
  S26: 'Sprint 26',
  BL: 'Backlog',
};
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
  { epic: 'HRIS-24', name: 'New Hire Checklist', type: 'Feature', sp: 5, done: true, sprint: 'BL' },
  { epic: 'HRIS-01a', name: 'Onboarding Gmail Surname', type: 'Feature', sp: 5, done: true, sprint: 'BL' },
  { epic: 'HRIS-01a', name: 'Onboarding Ip Assignment', type: 'Feature', sp: 5, done: true, sprint: 'BL' },
  { epic: 'HRIS-01a', name: 'Onboarding Pay Plans', type: 'Feature', sp: 5, done: true, sprint: 'BL' },
  { epic: 'HRIS-01a', name: 'Workspace Account Verify', type: 'Feature', sp: 3, done: true, sprint: 'BL' },
  { epic: 'HRIS-08', name: 'Bonus Calculator', type: 'Feature', sp: 5, done: true, sprint: 'BL' },
  { epic: 'HRIS-02a', name: 'Payroll Wizard Final Pay', type: 'Feature', sp: 5, done: true, sprint: 'BL' },
  { epic: 'HRIS-03a', name: 'Urgent Payments', type: 'Feature', sp: 5, done: true, sprint: 'BL' },
  { epic: 'HRIS-04', name: 'Time Adjustment Requests', type: 'Feature', sp: 5, done: true, sprint: 'BL' },
  { epic: 'HRIS-03c', name: 'Orphanage Dispute Flow', type: 'Feature', sp: 3, done: true, sprint: 'BL' },
  { epic: 'HRIS-05', name: 'Delete Authorization', type: 'Feature', sp: 3, done: true, sprint: 'BL' },
  { epic: 'HRIS-05', name: 'Rbac Feature Permissions', type: 'Feature', sp: 5, done: true, sprint: 'BL' },
  { epic: 'HRIS-05', name: 'Route Authorization', type: 'Feature', sp: 3, done: true, sprint: 'BL' },
  { epic: 'HRIS-07', name: 'Mesa', type: 'Feature', sp: 5, done: true, sprint: 'BL' },
  // Commit-derived tasks (2026-07-24 audit).
  { epic: 'HRIS-01a', name: 'CallTools username capture + orientation webhook', type: 'Feature', sp: 5, done: true, sprint: 'S24' },
  { epic: 'HRIS-01a', name: 'Offboarding queue processor + notifications', type: 'Feature', sp: 5, done: true, sprint: 'BL' },
  { epic: 'HRIS-01a', name: 'Resignation requests flow', type: 'Feature', sp: 3, done: true, sprint: 'BL' },
  { epic: 'HRIS-01a', name: '“Temporary Pause” offboard reason (suspend-only)', type: 'Feature', sp: 2, done: true, sprint: 'S24' },
  { epic: 'HRIS-01a', name: "Offboarding weekly pulse card (Teal's request)", type: 'Feature', sp: 2, done: true, sprint: 'S24' },
  { epic: 'HRIS-01a', name: 'Onboarding name split → structured first/last/extension columns', type: 'Feature', sp: 3, done: true, sprint: 'S25' },
  { epic: 'HRIS-01a', name: 'Re-hires landing invisible (offboard-row reuse) — fixes', type: 'Bug', sp: 3, done: true, sprint: 'S24' },
  { epic: 'HRIS-01a', name: 'clearOffboarded re-activation collision guard', type: 'Bug', sp: 2, done: true, sprint: 'S25' },
  { epic: 'HRIS-02a', name: 'Paystub freshness: staged ⊕ final-pay snapshot merge + mark-paid reconcile', type: 'Bug', sp: 5, done: true, sprint: 'S25' },
  { epic: 'HRIS-02a', name: 'MESA deduction integrity (no ₱100 for opt-outs + ledger-gap suppression at 7 sites)', type: 'Bug', sp: 3, done: true, sprint: 'S25' },
  { epic: 'HRIS-02a', name: 'Payroll performance indexes + anti-lag pass', type: 'Chore', sp: 3, done: true, sprint: 'BL' },
  { epic: 'HRIS-02a', name: 'USD⇄PHP conversion with cycle value-lock', type: 'Feature', sp: 3, done: true, sprint: 'BL' },
  { epic: 'HRIS-02b', name: 'PAB payout-week gate + neutral mid-period Additions pill', type: 'Feature', sp: 3, done: true, sprint: 'S24' },
  { epic: 'HRIS-02b', name: 'US holidays PAB forgiveness seed', type: 'Feature', sp: 2, done: true, sprint: 'BL' },
  { epic: 'HRIS-02b', name: 'Remove employee-facing PAB disputes (keep manager calendar + API)', type: 'Feature', sp: 2, done: true, sprint: 'S25' },
  { epic: 'HRIS-02b', name: 'HSL rate-history stale underpay — arrears remediation (≈₱1.06M, 121 under / 10 over)', type: 'Spike', sp: 5, done: false, sprint: 'S25', priority: 'High' },
  { epic: 'HRIS-02b', name: 'Rate change history + manager rate views', type: 'Feature', sp: 3, done: true, sprint: 'BL' },
  { epic: 'HRIS-03a', name: 'Mark Paid bank-details override (pencil mode + endpoint + notification)', type: 'Feature', sp: 5, done: true, sprint: 'S25' },
  { epic: 'HRIS-03a', name: 'Processor filter cards redesign + real logos; focus-mode removed', type: 'Feature', sp: 3, done: true, sprint: 'S25' },
  { epic: 'HRIS-03a', name: 'One-off Urgent payments (People → Pay → Urgent queue)', type: 'Feature', sp: 5, done: true, sprint: 'S25' },
  { epic: 'HRIS-03a', name: 'Dispatch undo + Done queue', type: 'Feature', sp: 3, done: true, sprint: 'BL' },
  { epic: 'HRIS-03b', name: 'Employee paystub modal + Pay Stubs profile tab + PDF/XLSX export', type: 'Feature', sp: 5, done: true, sprint: 'S24' },
  { epic: 'HRIS-03b', name: 'Salary “Ready to View” + “Paid” notifications', type: 'Feature', sp: 3, done: true, sprint: 'S24' },
  { epic: 'HRIS-03c', name: 'Orphanage vendors + vendor invoices', type: 'Feature', sp: 5, done: true, sprint: 'S24' },
  { epic: 'HRIS-03c', name: 'Orphanage worker payments', type: 'Feature', sp: 3, done: true, sprint: 'BL' },
  { epic: 'HRIS-03c', name: 'Orphanage budget requests + accounting approval', type: 'Feature', sp: 5, done: true, sprint: 'BL' },
  { epic: 'HRIS-04', name: 'Time-adjustment segments: require missed time-in/out (additive)', type: 'Feature', sp: 3, done: true, sprint: 'S24' },
  { epic: 'HRIS-05', name: 'Per-tab edit permission enforced on all write APIs (block view-only writes)', type: 'Feature', sp: 5, done: true, sprint: 'BL' },
  { epic: 'HRIS-05', name: 'Dashboard-only roles + per-tab ABAC + auto-provision on assign', type: 'Feature', sp: 5, done: true, sprint: 'BL' },
  { epic: 'HRIS-05', name: 'Session invalidation watcher + force logout + live reset', type: 'Feature', sp: 3, done: true, sprint: 'BL' },
  { epic: 'HRIS-05', name: 'Tickets gated by dedicated role (+ cleanup migration)', type: 'Feature', sp: 2, done: true, sprint: 'S24' },
  { epic: 'HRIS-06', name: 'Payment-catalog pay structures + PDF/CSV reports', type: 'Feature', sp: 5, done: true, sprint: 'BL' },
  { epic: 'HRIS-06', name: 'Employee KPI results view', type: 'Feature', sp: 3, done: true, sprint: 'BL' },
  { epic: 'HRIS-06', name: 'Medical Records: RFC as manual ₱ amount (not ×250)', type: 'Feature', sp: 2, done: true, sprint: 'S24' },
  { epic: 'HRIS-06', name: 'Bonus Catalog CRUD + formula engine — split of legacy 8-pt item', type: 'Feature', sp: 5, done: true, sprint: 'BL' },
  { epic: 'HRIS-06', name: 'Applied-bonus tracking + cadence + manager history — split', type: 'Feature', sp: 3, done: true, sprint: 'BL' },
  { epic: 'HRIS-07', name: 'MESA ledger DDL + backfill + membership preload', type: 'Feature', sp: 5, done: true, sprint: 'S24' },
  { epic: 'HRIS-07', name: 'MESA per-stint accounts (YY-MM-##### numbering)', type: 'Feature', sp: 3, done: true, sprint: 'S24' },
  { epic: 'HRIS-07', name: 'MESA notes + Non Members Opt In/Out bridge', type: 'Feature', sp: 3, done: true, sprint: 'S24' },
  { epic: 'HRIS-07', name: 'Weekly 100+300 ledger deposits on upload + opt-in date derivation', type: 'Feature', sp: 3, done: true, sprint: 'S25' },
  { epic: 'HRIS-09', name: 'Skill sets + Employee Team roster', type: 'Feature', sp: 5, done: true, sprint: 'BL' },
  { epic: 'HRIS-09', name: 'FPU enrollment flow', type: 'Feature', sp: 3, done: true, sprint: 'BL' },
  { epic: 'HRIS-09', name: 'Medals & commendations', type: 'Feature', sp: 3, done: true, sprint: 'BL' },
  { epic: 'HRIS-09', name: 'Profile name-parts editor (First/Middle/Last/Ext/Nickname)', type: 'Feature', sp: 3, done: true, sprint: 'S25' },
  { epic: 'HRIS-09', name: 'Profile completion card + payout fields', type: 'Feature', sp: 3, done: true, sprint: 'BL' },
  { epic: 'HRIS-12', name: 'HR + Admin Global Master List editors (incl. People-tab GML edit)', type: 'Feature', sp: 5, done: true, sprint: 'S24' },
  { epic: 'HRIS-13', name: 'Cobrowse chat window + providers', type: 'Feature', sp: 5, done: true, sprint: 'S24' },
  { epic: 'HRIS-13', name: 'Observe-mode mirror: driver-opened modals invisible — rrweb style-rules fix', type: 'Bug', sp: 3, done: true, sprint: 'S25' },
  { epic: 'HRIS-13', name: 'Presence heartbeat + last-seen', type: 'Feature', sp: 3, done: true, sprint: 'BL' },
  { epic: 'HRIS-13', name: 'HR collab layer (shared cursors on checklist)', type: 'Feature', sp: 3, done: true, sprint: 'BL' },
  { epic: 'HRIS-14', name: 'Google Sheet sync crons (master / rates / HSL / offboarded) — split of legacy Csv Imports', type: 'Integration', sp: 5, done: true, sprint: 'BL' },
  { epic: 'HRIS-14', name: 'CSV imports admin tab — split of legacy Csv Imports', type: 'Feature', sp: 3, done: true, sprint: 'BL' },
  { epic: 'HRIS-14', name: 'Master-list sync race + orphaned-upload guard', type: 'Bug', sp: 3, done: true, sprint: 'S24' },
  { epic: 'HRIS-14', name: 'Webhooks admin + bank-info-missing red-alarm notify email', type: 'Integration', sp: 2, done: true, sprint: 'S25' },
  { epic: 'HRIS-15', name: 'Dashboard-switch performance Tier 0 + PAB ?all_files=1 batch', type: 'Chore', sp: 5, done: true, sprint: 'S25' },
  { epic: 'HRIS-15', name: 'Collapsible sidebar shell redesign', type: 'Feature', sp: 3, done: true, sprint: 'S24' },
  { epic: 'HRIS-15', name: 'System diagnostics + API-500 hardening', type: 'Chore', sp: 3, done: true, sprint: 'BL' },
  { epic: 'HRIS-15', name: 'Mobile responsiveness pass (all dashboards)', type: 'Chore', sp: 5, done: true, sprint: 'BL' },
  { epic: 'HRIS-15', name: 'Admin search bar + pages registry', type: 'Feature', sp: 3, done: true, sprint: 'BL' },
  { epic: 'HRIS-15', name: 'Impersonation (view-as) banner + auth', type: 'Feature', sp: 3, done: true, sprint: 'BL' },
  { epic: 'HRIS-15', name: 'Run outstanding Supabase migrations + re-import n8n workflows (12+ pending SQL files)', type: 'Chore', sp: 3, done: false, sprint: 'S25', priority: 'Critical' },
  { epic: 'HRIS-19', name: 'Legacy rates-sheet cell can route null-preferred → hurupay: decision + guard', type: 'Spike', sp: 2, done: false, sprint: 'S25', priority: 'High' },
  { epic: 'HRIS-24', name: 'Referred-by column + Referrals week section (email-tier matching)', type: 'Feature', sp: 3, done: true, sprint: 'S24' },
  // ── Sprint 26 reconciliation — shipped Jul 29 – Aug 5 2026 ─────────────────
  // Grouped from 171 commits by feature, not by commit. SP scored against the
  // live Sprint 26 items (1–5, avg 3.49); anything that rolled up to 8+ became
  // an epic instead (HRIS-33). Commit SHAs live in each board item's update.
  { epic: 'HRIS-01a', name: 'Manager Suspend + Reactivation (temp-pause) riding the offboarding-deactivate flow', type: 'Feature', sp: 5, done: true, sprint: 'S26' },
  { epic: 'HRIS-02a', name: 'Per-cycle FX zero placeholders — dispatch hard-blocked until both legs are set', type: 'Feature', sp: 5, done: true, sprint: 'S26' },
  { epic: 'HRIS-02a', name: 'Rate snapshots toggle on Dispatch — floating People/Catalog cards', type: 'Feature', sp: 2, done: true, sprint: 'S26' },
  { epic: 'HRIS-02b', name: 'Mid-week rate-change proration on the statement — catalog-consistent history, both engines', type: 'Feature', sp: 5, done: true, sprint: 'S26' },
  { epic: 'HRIS-02b', name: 'Rate-history effective_from snapped to the pay-week start', type: 'Bug', sp: 3, done: true, sprint: 'S26' },
  { epic: 'HRIS-02b', name: 'HSL OT-rate arrears audit + remediation — weekend premium sat in the OT column', type: 'Chore', sp: 5, done: true, sprint: 'S26' },
  { epic: 'HRIS-02b', name: 'PAB exclusion → employee notification (route + DDL + wizard toggle)', type: 'Feature', sp: 3, done: true, sprint: 'S26' },
  { epic: 'HRIS-03a', name: 'Sub-₱7k PHP wires reroute to Wise + Under ₱7k dispatch filter chip', type: 'Feature', sp: 3, done: true, sprint: 'S26' },
  { epic: 'HRIS-03a', name: 'Urgent payments: week-long bucket (Pending/Paid/Not Paid) + Undo + n8n alert', type: 'Feature', sp: 5, done: true, sprint: 'S26' },
  { epic: 'HRIS-03a', name: 'Colombian payees show/copy their native COP amount', type: 'Feature', sp: 3, done: true, sprint: 'S26' },
  { epic: 'HRIS-03a', name: 'Payment cycle 100% paid → completion email to Accounting', type: 'Integration', sp: 2, done: true, sprint: 'S26' },
  { epic: 'HRIS-03a', name: 'Staged-only dispatch placement guard', type: 'Bug', sp: 3, done: true, sprint: 'S26' },
  { epic: 'HRIS-03b', name: 'HSL Weekend Hours itemized under Earnings + transfer-week day scoping', type: 'Feature', sp: 5, done: true, sprint: 'S26' },
  { epic: 'HRIS-03b', name: 'Accounting-only dispatch log panel on the Pay Stub modal + Excluded/Paid Records rework', type: 'Feature', sp: 5, done: true, sprint: 'S26' },
  { epic: 'HRIS-03b', name: 'Tech bonus on recovered weeks + one paystub row per week', type: 'Bug', sp: 3, done: true, sprint: 'S26' },
  { epic: 'HRIS-03b', name: 'Paystub rate-consistency guard — Payment Catalog is the source of truth', type: 'Bug', sp: 3, done: true, sprint: 'S26' },
  { epic: 'HRIS-05', name: 'security_invoker on active_employees blanked the wizard dept source — restore + verifier', type: 'Bug', sp: 3, done: true, sprint: 'S26' },
  { epic: 'HRIS-05', name: 'Roster bulk check hit an RLS-blocked view — direct GML read via /api/roster/gml-status', type: 'Bug', sp: 3, done: true, sprint: 'S26' },
  { epic: 'HRIS-06', name: 'Payment Catalog Overview → Summary pay-mix dashboard', type: 'Feature', sp: 5, done: true, sprint: 'S26' },
  { epic: 'HRIS-06', name: 'Payment Catalog Department cards + Search hero dock-to-top glide', type: 'Feature', sp: 2, done: true, sprint: 'S26' },
  { epic: 'HRIS-06', name: "Shared master-list email merged two people's KPI bonuses", type: 'Bug', sp: 3, done: true, sprint: 'S26' },
  { epic: 'HRIS-06', name: '“Set rate” updates the existing pay structure instead of dying on a duplicate key', type: 'Bug', sp: 2, done: true, sprint: 'S26' },
  { epic: 'HRIS-07', name: 'MESA disbursement receipts — Receipt column, gallery, Approved/Paid from dispatch', type: 'Feature', sp: 3, done: true, sprint: 'S26' },
  { epic: 'HRIS-08', name: 'Custom System Bonuses in COP/USD (PAB & Tech currency variants)', type: 'Feature', sp: 5, done: true, sprint: 'S26' },
  { epic: 'HRIS-09', name: 'Employee Pay snapshot grid + one-page Pay Summary PDF', type: 'Feature', sp: 3, done: true, sprint: 'S26' },
  { epic: 'HRIS-10', name: 'My Team: MESA-style table + card parity with row actions', type: 'Feature', sp: 3, done: true, sprint: 'S26' },
  { epic: 'HRIS-11', name: 'Overview Total Payout hero counts the full pay run (payout extras)', type: 'Feature', sp: 3, done: true, sprint: 'S26' },
  { epic: 'HRIS-13', name: 'Collab on/off as an admin system setting', type: 'Feature', sp: 3, done: true, sprint: 'S26' },
  { epic: 'HRIS-13', name: 'Observe mirror portaled to the document body so the sidebar cannot overlap it', type: 'Bug', sp: 1, done: true, sprint: 'S26' },
  { epic: 'HRIS-15', name: "Page every roster/pay read past PostgREST's silent 1000-row cap", type: 'Bug', sp: 3, done: true, sprint: 'S26' },
  { epic: 'HRIS-15', name: 'Webhooks admin: sample payloads for every configured slug', type: 'Feature', sp: 2, done: true, sprint: 'S26' },
  { epic: 'HRIS-18', name: 'HRIS generates the Certificate of Engagement — no upload', type: 'Feature', sp: 5, done: true, sprint: 'S26' },
  { epic: 'HRIS-18', name: 'Employee document preview panel', type: 'Feature', sp: 3, done: true, sprint: 'S26' },
  { epic: 'HRIS-20', name: 'Wizard Setup readiness checklist as its own first tab + week-scoped roster + step-1 CSV modal', type: 'Feature', sp: 5, done: true, sprint: 'S26' },
  { epic: 'HRIS-20', name: 'Bank Info per-week Temporary Exemption', type: 'Feature', sp: 3, done: true, sprint: 'S26' },
  { epic: 'HRIS-20', name: 'Payroll Notes FAB readiness ring + Readiness leads the tab strip', type: 'Feature', sp: 3, done: true, sprint: 'S26' },
  { epic: 'HRIS-21', name: 'Payroll Notes Offboarded tab — final-pay rate/bank for leavers', type: 'Feature', sp: 5, done: true, sprint: 'S26' },
  { epic: 'HRIS-21', name: 'Payroll Notes tab cache — board, readiness + rates no longer re-pulled', type: 'Chore', sp: 2, done: true, sprint: 'S26' },
  { epic: 'HRIS-24', name: 'Checklist lock webhook sanitizes emails so one bad cell cannot strand the week', type: 'Bug', sp: 2, done: true, sprint: 'S26' },
  { epic: 'HRIS-26', name: 'HR Transfers tab shows the full transfer trail again', type: 'Bug', sp: 2, done: true, sprint: 'S26' },
  { epic: 'HRIS-27', name: 'Contractor invoices period-scoped to the pay cycle; dispatch rows open the invoice', type: 'Feature', sp: 5, done: true, sprint: 'S26' },
  { epic: 'HRIS-28', name: 'Penny AI: full audit-log visibility (timeline, notes history, action catalogue)', type: 'Feature', sp: 3, done: true, sprint: 'S26' },
  { epic: 'HRIS-30', name: 'Collections TL + Simple Texting removed from the HSL schema + DB purge', type: 'Feature', sp: 2, done: true, sprint: 'S26' },
  { epic: 'HRIS-33', name: 'Pay-cycle report snapshot model + publish/list/unpublish API', type: 'Feature', sp: 5, done: true, sprint: 'S26' },
  { epic: 'HRIS-33', name: 'Reports tab: list, detail view + CSV/XLSX/PDF export', type: 'Feature', sp: 5, done: true, sprint: 'S26' },
  { epic: 'HRIS-33', name: 'Publish-gate + unpublish-audit hardening', type: 'Bug', sp: 3, done: true, sprint: 'S26' },
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
  // Blocked on an un-run external step — Backlog, corrected to Pending Deploy by the skill.
  // 8, not 5 (Kane 2026-08-11): three pay engines repriced in lockstep + a new
  // payload contract (hogan_sheet) consumed by five render surfaces + four
  // validators. Scored with this pass's other multi-subsystem 8s, not with the
  // single-surface HSL 5s. Still a task — over 8 is the epic line.
  { epic: 'HRIS-02b', name: 'HSL pay = the Hogan sheet column AN verbatim — hogan-week-pay becomes the single rate authority, reversing the 2026-08-07 weekend-OT removal', type: 'Feature', sp: 8, done: true, sprint: 'BL' },
  { epic: 'HRIS-03b', name: 'One merged Weekend Hours line + dated rate-change disclosure on statement, email and export', type: 'Feature', sp: 5, done: true, sprint: 'BL' },
  { epic: 'HRIS-03b', name: 'Paystub email HTML rendered in-app (n8n Gmail becomes a pipe) + System Bonus snapshot columns on payment_dispatches', type: 'Feature', sp: 8, done: true, sprint: 'BL' },
  { epic: 'HRIS-01a', name: 'Offboarding is delete-only: suspend is its own path, suspended-person offboards escalate to delete, and leavers get a correct final check', type: 'Feature', sp: 8, done: false, sprint: 'BL' },
  { epic: 'HRIS-06', name: 'One HSL department + required sub-department that sets the base rate, wired through the Payment Catalog', type: 'Feature', sp: 8, done: false, sprint: 'BL' },
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
];
