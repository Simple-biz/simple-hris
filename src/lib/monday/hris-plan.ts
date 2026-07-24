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
  BL: 'group_mm4m1eqp', // Backlog
} as const;
export const TASK_COLS = {
  owner: 'multiple_person_mm4m9frz',
  type: 'color_mm4m786c', // 0 Feature · 1 Bug · 2 Integration · 5 Chore · 6 Spike
  status: 'color_mm4mts9b', // 0 Ready to Start · 4 Done
  priority: 'color_mm4m2j0z', // 0 Critical · 1 High · 2 Medium · 3 Low
  estimatedSp: 'numeric_mm4mpgqk',
  actualSp: 'numeric_mm4mevqb',
  sprint: 'color_mm4mw08e', // 0 Sprint 24 · 1 Sprint 25 · 2 Backlog
  project: 'board_relation_mm4mrsvm',
  epic: 'board_relation_mm4mp3yb',
} as const;

/** Projects Portfolio columns (the HRIS project item) */
export const PROJECT_COLS = {
  status: 'color_mm4mfemh', // 4 = Live
  totalSp: 'numeric_mm4mw98f',
  spCompleted: 'numeric_mm4mkb4y',
  sprintTasks: 'board_relation_mm4mwppe',
} as const;

export type Quarter = 'Q1' | 'Q2' | 'Q3' | 'Q4';
export type EpicStatus = 'Planned' | 'In Progress' | 'Shipped';
export type TaskType = 'Feature' | 'Bug' | 'Integration' | 'Chore' | 'Spike';
export type TaskSprint = keyof typeof TASK_GROUPS;
export type TaskPriority = 'Critical' | 'High' | null;

export const EPIC_STATUS_INDEX: Record<EpicStatus, number> = {
  Planned: 0,
  'In Progress': 1,
  Shipped: 2,
};
export const QUARTER_INDEX: Record<Quarter, number> = { Q1: 0, Q2: 1, Q3: 2, Q4: 3 };
export const TASK_TYPE_INDEX: Record<TaskType, number> = {
  Feature: 0,
  Bug: 1,
  Integration: 2,
  Chore: 5,
  Spike: 6,
};
export const TASK_SPRINT_INDEX: Record<TaskSprint, number> = { S24: 0, S25: 1, BL: 2 };
export const TASK_PRIORITY_INDEX: Record<Exclude<TaskPriority, null>, number> = {
  Critical: 0,
  High: 1,
};
export const TASK_STATUS_DONE = 4;
export const TASK_STATUS_READY = 0;

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
  sp: number; // < 8 by definition (8+ belongs on the epics board)
  /** Initial done-ness — applied only when the task is CREATED, never on update. */
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
];
