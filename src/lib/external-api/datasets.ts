/**
 * The Data catalog — every dataset an outside system may read today, may read one
 * day, or will never read — shown on Admin → Webhooks & Integrations → Data catalog.
 *
 * Kane, 2026-09-25: *"a new tab inside this integrations page where we can have the
 * documentation of the Data we can let people have access to … the first one would be
 * Global Master List … we should know which clients have access … other Data like
 * Bank Info … Offboarded … arrange them properly."* He took all three recommendations
 * on the brief (audit item 218): planned datasets are SHOWN, labelled not reachable;
 * Bank Info never offers a full account, routing or SWIFT number; and this file stays
 * DOCUMENTATION — Phase A's `resources/*.ts` registry
 * (`docs/superpowers/plans/2026-09-21-external-api-resources-and-writes.md`) replaces
 * it when a second dataset actually ships.
 *
 * Rules this file owns:
 *
 *  - **Only a `live` dataset has a way in.** `scope`, `restPath` and `mcpTool` exist on
 *    the `live` variant alone, so the compiler refuses them on a planned entry, and
 *    `datasets.test.ts` pins the live set BOTH ways against controls outside this file:
 *    the SQL `external_api_clients_scopes_known` CHECK, the route files on disk, and
 *    `MCP_TOOL_NAMES`. A planned page that looked reachable would get a partner told
 *    "yes, pull bank info" when no key can.
 *  - **The GML fields ARE `catalog.ts`**, imported by reference — never retyped. The
 *    catalog is what the picker offers and the API serves; a second copy here would
 *    document columns the API does not have.
 *  - **Planned fields are proposals.** Names and the final list are decided when the
 *    dataset is built (under `blueprint`, as a new scope + catalog + route —
 *    `external-api-integrations.md` § One table = one route).
 *  - **Names only.** Nothing here holds a value; no row, no bank number, no count
 *    that could go stale. Who holds access is computed from the live client list
 *    (`dataset-access.ts`), never written down.
 *
 * Pure: the client bundle imports it.
 */
import { ALWAYS_COLUMNS, GML_CATALOG, GML_TABLE_KEY, GML_TABLE_LABEL, NEVER_COLUMNS, type CatalogGroup } from './catalog';

// ─── Areas ────────────────────────────────────────────────────────────────────

export type DatasetDomain = 'people' | 'time' | 'pay' | 'banking' | 'performance' | 'never';

export const DATASET_DOMAINS: ReadonlyArray<{ id: DatasetDomain; label: string; blurb: string }> = [
  { id: 'people', label: 'People & roster', blurb: 'Who works here, where, and who left.' },
  { id: 'time', label: 'Time & attendance', blurb: 'Hours, adjustments, leave and training attendance.' },
  { id: 'pay', label: 'Pay', blurb: 'Rates and money paid. Money fields start unticked when these ship.' },
  { id: 'banking', label: 'Banking', blurb: 'How people are paid. Full account numbers never leave the HRIS.' },
  { id: 'performance', label: 'Performance', blurb: 'KPI and QC scores.' },
  { id: 'never', label: 'Never offered', blurb: 'Data no key will ever read, listed so the answer is on record.' },
];

// ─── Shapes ───────────────────────────────────────────────────────────────────

export type DatasetStatus = 'live' | 'planned' | 'never';

/**
 * How careful a grant must be. `low` = directory data; `personal` = contact, address,
 * photo; `money` = rates and amounts; `restricted` = banking and identity documents.
 */
export type Sensitivity = 'low' | 'personal' | 'money' | 'restricted';

export const SENSITIVITY_LABELS: Record<Sensitivity, string> = {
  low: 'Low',
  personal: 'Personal',
  money: 'Money',
  restricted: 'Restricted',
};

/** A field group. GML's groups come from `catalog.ts`; planned datasets add theirs. */
export type DatasetFieldGroup = CatalogGroup | 'time' | 'money' | 'banking' | 'status';

export const FIELD_GROUP_LABELS: Record<DatasetFieldGroup, string> = {
  identity: 'Identity',
  work: 'Work',
  contact: 'Contact',
  address: 'Home address',
  photo: 'Photos',
  system: 'System',
  time: 'Time',
  money: 'Money',
  banking: 'Banking',
  status: 'Status',
};

export type DatasetField = {
  readonly name: string;
  readonly group: DatasetFieldGroup;
  readonly sensitive: boolean;
  readonly description: string;
};

/** Something a reader must know that is not a field. `open` = a known defect, dated. */
export type DatasetCaveat = {
  readonly kind: 'open' | 'note';
  readonly text: string;
  /** Where the fact lives — an audit item, a memory entry, a doc. */
  readonly ref?: string;
};

type DatasetBase = {
  readonly slug: string;
  readonly label: string;
  readonly domain: DatasetDomain;
  /** One line: what it is for. */
  readonly summary: string;
  /** The tables (or resolver) the data comes from. */
  readonly sources: readonly string[];
  readonly sensitivity: Sensitivity;
  readonly caveats: readonly DatasetCaveat[];
};

export type LiveDataset = DatasetBase & {
  readonly status: 'live';
  /** The scope a key must hold. Pinned to the SQL CHECK by the test. */
  readonly scope: string;
  readonly restPath: string;
  readonly mcpTool: string;
  /** What one row is. */
  readonly grain: string;
  /** Whether leavers are served, and how that is enforced. */
  readonly leavers: string;
  readonly filters: readonly string[];
  readonly paging: string;
  /** What the admin picks from. */
  readonly fields: readonly DatasetField[];
  /** Served to every key whatever it was granted. */
  readonly always: readonly string[];
  /** Read by nobody outside the HRIS, even a whole-table key. */
  readonly neverServed: readonly string[];
};

export type PlannedDataset = DatasetBase & {
  readonly status: 'planned';
  readonly grain: string;
  readonly leavers: string;
  /** PROPOSED — decided when the dataset is built. */
  readonly fields: readonly DatasetField[];
  readonly neverServed: readonly string[];
  /** Where the work is tracked, when it already is. */
  readonly tracking?: string;
};

export type NeverDataset = DatasetBase & {
  readonly status: 'never';
  readonly reason: string;
};

export type Dataset = LiveDataset | PlannedDataset | NeverDataset;

const f = (name: string, group: DatasetFieldGroup, description: string, sensitive = false): DatasetField => ({
  name,
  group,
  sensitive,
  description,
});

// ─── The catalog ──────────────────────────────────────────────────────────────

export const GLOBAL_MASTER_LIST_DATASET: LiveDataset = {
  slug: 'global-master-list',
  label: GML_TABLE_LABEL,
  domain: 'people',
  status: 'live',
  summary: 'The active roster: who works here, in which department, and how to reach them.',
  sources: [GML_TABLE_KEY],
  sensitivity: 'personal',
  scope: 'global_master_list.read',
  restPath: '/api/external/v1/global-master-list',
  mcpTool: 'query_global_master_list',
  grain:
    'One row per master-list row. A person with two genuine roles (e.g. Manager and USEE) has two rows; the API reports the table and does not merge identities.',
  leavers: 'Hidden. Only rows with no off-boarded stamp are served, checked in SQL and again in memory.',
  filters: ['department', 'email', 'search', 'limit', 'cursor'],
  paging: 'limit 1–500 (default 100). Follow page.next_cursor until it is null.',
  fields: GML_CATALOG,
  always: ALWAYS_COLUMNS,
  neverServed: NEVER_COLUMNS,
  caveats: [
    {
      kind: 'open',
      text: 'The public anon key, which ships in the login page’s JavaScript, can read this whole table, including personal email, phone and home address. Column grants protect it from API keys, not from the browser bundle. Measured 2026-09-21, re-measured 2026-09-25 (2,834 rows): not fixed.',
      ref: 'Audit items 136 · 221 · memory gml-anon-readable-undercuts-column-grants',
    },
    {
      kind: 'note',
      text: 'A filter on a column the key cannot see is refused (400 column_not_granted), so a hidden email cannot be confirmed by searching for it.',
      ref: 'external-api-integrations.md § Columns are a GRANT',
    },
  ],
};

export const DATASETS: readonly Dataset[] = [
  // ── People & roster ─────────────────────────────────────────────────────────
  GLOBAL_MASTER_LIST_DATASET,
  {
    slug: 'offboarded',
    label: 'Offboarded',
    domain: 'people',
    status: 'planned',
    summary: 'Who left, when, from which department, and the reason category.',
    sources: ['global_master_list (off_boarded_* stamps)', 'offboarded_sheet (leavers before 2026-04-21)'],
    sensitivity: 'personal',
    grain: 'One row per departure. A re-hire who left twice has two rows.',
    leavers: 'This dataset is the leavers.',
    fields: [
      f('name', 'identity', 'Full name'),
      f('work_email', 'contact', 'Company email at the time they left'),
      f('department', 'work', 'Department they left from'),
      f('start_date', 'work', 'First day'),
      f('off_boarded_at', 'status', 'Date they left'),
      f('off_boarded_reason', 'status', 'Reason category (resigned, terminated, temporary pause …)'),
    ],
    neverServed: ['off_boarded_note', 'off_boarded_by', 'personal contact and home address'],
    caveats: [
      {
        kind: 'note',
        text: 'The master list starts 2026-04-21. About 2,532 earlier leavers exist only on offboarded_sheet, so the dataset needs both sources or it silently starts in April.',
        ref: 'memory ledger-only-leaver-no-master-row',
      },
      {
        kind: 'note',
        text: 'Temporary pause is an offboard reason but the person is suspended, not gone. Decide whether it is served as a departure.',
        ref: 'memory temporary-pause-offboard-reason',
      },
      {
        kind: 'open',
        text: 'Some re-hires still carry an old off-boarded stamp and would read as departed.',
        ref: 'memory rehire-invisible-offboard-reuse',
      },
    ],
  },
  {
    slug: 'departments',
    label: 'Departments & teams',
    domain: 'people',
    status: 'planned',
    summary: 'Every department and HSL sub-team, its managers, and its headcount.',
    sources: ['global_master_list (Department)', 'department_managers', 'hsl_team_members'],
    sensitivity: 'low',
    grain: 'One row per department or sub-team.',
    leavers: 'Headcount counts active people only.',
    fields: [
      f('department', 'work', 'Department name'),
      f('sub_team', 'work', 'HSL sub-team, when there is one'),
      f('managers', 'work', 'Manager work emails'),
      f('headcount', 'work', 'Active people in it'),
    ],
    neverServed: [],
    caveats: [
      {
        kind: 'note',
        text: 'The HRIS, not the Google Sheet, is the source of truth for Department (Kane, 2026-08-21).',
        ref: 'memory hris-is-dept-source-of-truth',
      },
    ],
  },
  {
    slug: 'transfers',
    label: 'Department transfers',
    domain: 'people',
    status: 'planned',
    summary: 'Who moved from which department to which, and from when.',
    sources: ['department_transfer_requests'],
    sensitivity: 'low',
    grain: 'One row per applied transfer.',
    leavers: 'Included. A transfer stays history after the person leaves.',
    fields: [
      f('name', 'identity', 'Full name'),
      f('work_email', 'contact', 'Company email'),
      f('from_department', 'work', 'Department they left'),
      f('to_department', 'work', 'Department they joined'),
      f('effective_date', 'time', 'When the move took effect'),
    ],
    neverServed: ['requester notes', 'rate changes (a transfer does not re-rate)'],
    caveats: [],
  },
  {
    slug: 'onboarding',
    label: 'New hires & onboarding',
    domain: 'people',
    status: 'planned',
    summary: 'People in onboarding and how far along they are.',
    sources: ['hr_pending_employees', 'hr_new_hire_checklist'],
    sensitivity: 'low',
    grain: 'One row per person in onboarding.',
    leavers: 'n/a. A person leaves this dataset when promoted to the master list.',
    fields: [
      f('name', 'identity', 'Full name'),
      f('work_email', 'contact', 'Company email, once issued'),
      f('department', 'work', 'Department they are joining'),
      f('stage', 'status', 'Where they are in onboarding'),
      f('start_date', 'work', 'Planned first day'),
      f('checklist_done', 'status', 'Checklist items done, of total'),
    ],
    neverServed: ['everything in hr_onboarding_submissions: ID documents, bank details, contracts, signatures'],
    caveats: [],
  },

  // ── Time & attendance ───────────────────────────────────────────────────────
  {
    slug: 'weekly-hours',
    label: 'Weekly hours',
    domain: 'time',
    status: 'planned',
    summary: 'Hubstaff hours per person per week, as the payroll wizard saw them.',
    sources: ['hubstaff_hours'],
    sensitivity: 'low',
    grain: 'One row per person per pay week.',
    leavers: 'Included for the weeks they worked.',
    fields: [
      f('work_email', 'contact', 'Company email'),
      f('name', 'identity', 'Full name'),
      f('department', 'work', 'Department that week'),
      f('week_start', 'time', 'Sunday the week starts'),
      f('week_end', 'time', 'Saturday the week ends'),
      f('total_hours', 'time', 'Hours worked that week'),
      f('daily_hours', 'time', 'Hours per day, Sunday to Saturday'),
    ],
    neverServed: ['upload bookkeeping (batch ids, source file names)'],
    caveats: [
      {
        kind: 'note',
        text: 'Weeks must be named by their parsed date range, not the upload filename. The same week has been uploaded as "… (1).csv".',
        ref: 'memory orphanage-source-file-drift-hides-a-week',
      },
      {
        kind: 'note',
        text: 'Hubstaff day cells are duration strings, not numbers.',
        ref: 'memory employee-current-paycycle',
      },
    ],
  },
  {
    slug: 'time-adjustments',
    label: 'Time adjustments',
    domain: 'time',
    status: 'planned',
    summary: 'Approved changes to a day’s hours, and who approved them.',
    sources: ['time_adjustment_requests'],
    sensitivity: 'low',
    grain: 'One row per approved adjustment.',
    leavers: 'Included.',
    fields: [
      f('work_email', 'contact', 'Company email'),
      f('day', 'time', 'The day adjusted'),
      f('hours_before', 'time', 'Hours on record before'),
      f('hours_after', 'time', 'Approved hours'),
      f('approved_by', 'status', 'Approver work email'),
      f('approved_at', 'status', 'When it was approved'),
    ],
    neverServed: ['the employee’s free-text reason'],
    caveats: [
      {
        kind: 'open',
        text: 'Two screens disagree on approved hours today. The dataset must use the one shared rule, not either screen.',
        ref: 'memory time-adjustment-approved-hours-derived (item 204)',
      },
    ],
  },
  {
    slug: 'leave',
    label: 'Leave',
    domain: 'time',
    status: 'planned',
    summary: 'Approved leave: who is off, which days, and what type.',
    sources: ['leave_requests'],
    sensitivity: 'personal',
    grain: 'One row per approved leave request.',
    leavers: 'Included.',
    fields: [
      f('work_email', 'contact', 'Company email'),
      f('leave_type', 'status', 'Leave type'),
      f('start_date', 'time', 'First day off'),
      f('end_date', 'time', 'Last day off'),
      f('status', 'status', 'Request status'),
    ],
    neverServed: ['the reason text', 'any medical detail or attachment'],
    caveats: [],
  },
  {
    slug: 'schedules',
    label: 'Schedules',
    domain: 'time',
    status: 'planned',
    summary: 'The shift each person is scheduled for, by period.',
    sources: ['employee_schedule_periods'],
    sensitivity: 'low',
    grain: 'One row per person per schedule period.',
    leavers: 'Hidden.',
    fields: [
      f('work_email', 'contact', 'Company email'),
      f('period_start', 'time', 'Period start'),
      f('period_end', 'time', 'Period end'),
      f('shift', 'time', 'Scheduled shift'),
    ],
    neverServed: [],
    caveats: [],
  },
  {
    slug: 'training-attendance',
    label: 'Training attendance',
    domain: 'time',
    status: 'planned',
    summary: 'FPU class enrollment and session attendance.',
    sources: ['fpu_classes', 'fpu_enrollments', 'fpu_session_attendance'],
    sensitivity: 'low',
    grain: 'One row per person per session.',
    leavers: 'Included.',
    fields: [
      f('work_email', 'contact', 'Company email'),
      f('class', 'work', 'Class name'),
      f('session_date', 'time', 'Session date'),
      f('attended', 'status', 'Attendance mark for the session'),
    ],
    neverServed: [],
    caveats: [],
  },

  // ── Pay ─────────────────────────────────────────────────────────────────────
  {
    slug: 'pay-rates',
    label: 'Pay rates',
    domain: 'pay',
    status: 'planned',
    summary: 'The hourly rate each person is actually paid at.',
    sources: ['src/lib/payroll/resolve-rate.ts over payment_catalog_pay_structures, employee_rate_history, employee_hourly_rates'],
    sensitivity: 'money',
    grain: 'One row per person, the rate in force today.',
    leavers: 'Hidden.',
    fields: [
      f('work_email', 'contact', 'Company email'),
      f('department', 'work', 'Department the rate is for'),
      f('regular_rate', 'money', 'Regular hourly rate', true),
      f('ot_rate', 'money', 'Overtime hourly rate', true),
      f('currency', 'money', 'PHP, USD …'),
      f('rate_source', 'status', 'Individual, sheet, or department default'),
    ],
    neverServed: ['rate history and overrides'],
    caveats: [
      {
        kind: 'note',
        text: 'Must serve the RESOLVED rate (individual → sheet → department), never one table. Each table alone disagrees with what is paid.',
        ref: 'memory rate-catalog-source-of-truth',
      },
    ],
  },
  {
    slug: 'payroll-results',
    label: 'Payroll results',
    domain: 'pay',
    status: 'planned',
    summary: 'What each person was paid, per pay cycle.',
    sources: ['payment_dispatches', 'disbursement_records'],
    sensitivity: 'money',
    grain: 'One row per person per pay cycle.',
    leavers: 'Included for the cycles they were paid.',
    fields: [
      f('work_email', 'contact', 'Company email'),
      f('cycle', 'time', 'Pay week'),
      f('hours', 'time', 'Hours paid'),
      f('net_pay', 'money', 'Net amount paid', true),
      f('currency', 'money', 'Currency paid in'),
      f('paid_at', 'status', 'When it was marked paid'),
      f('processor', 'banking', 'Wise, bank, wallet …'),
    ],
    neverServed: ['bank account numbers', 'dispatch notes'],
    caveats: [
      {
        kind: 'note',
        text: 'A pay week adds up on the payroll’s own identity: Regular + OT + Bonus total + Orphanage − MESA deduction + MESA disbursement = Amount. Serve the parts so they sum.',
        ref: 'payment-dispatch.md §4.2.3 · memory penny-computed-vs-paid-unreconciled',
      },
    ],
  },
  {
    slug: 'bonuses',
    label: 'Bonuses',
    domain: 'pay',
    status: 'planned',
    summary: 'KPI and system bonuses applied to each person, per week.',
    sources: ['bonus_catalog_applied'],
    sensitivity: 'money',
    grain: 'One row per bonus applied.',
    leavers: 'Included.',
    fields: [
      f('work_email', 'contact', 'Company email'),
      f('week', 'time', 'Pay week'),
      f('bonus', 'work', 'Bonus name'),
      f('department', 'work', 'Department it was scored in'),
      f('amount', 'money', 'Amount', true),
    ],
    neverServed: [],
    caveats: [
      {
        kind: 'open',
        text: 'One person scored in two departments in one week is summed. Unruled as of 2026-09-22.',
        ref: 'memory kpi-one-person-two-departments',
      },
    ],
  },
  {
    slug: 'orphanage-pay',
    label: 'Orphanage pay',
    domain: 'pay',
    status: 'planned',
    summary: 'What each person earned for orphanage hours, per week, with a reconciliation verdict.',
    sources: ['orphanage_pay'],
    sensitivity: 'money',
    grain: 'One row per person per week.',
    leavers: 'Included (Kane, 2026-09-21).',
    fields: [
      f('employee_email', 'contact', 'Company email'),
      f('employee_name', 'identity', 'Full name'),
      f('week_start', 'time', 'Week start'),
      f('week_end', 'time', 'Week end'),
      f('hours', 'time', 'Total hours'),
      f('reg_hours', 'time', 'Regular hours'),
      f('ot_hours', 'time', 'Overtime hours'),
      f('regular_rate_php', 'money', 'Regular rate', true),
      f('ot_rate_php', 'money', 'Overtime rate', true),
      f('amount_php', 'money', 'Amount', true),
    ],
    neverServed: ['locked_by', 'locked_at', 'created_at', 'updated_at'],
    tracking: 'Audit item 123 · docs/superpowers/plans/2026-09-21-external-api-resources-and-writes.md (Phase A, not started)',
    caveats: [
      {
        kind: 'note',
        text: 'Hand-typed amounts write no orphanage_pay row, so a week summed from this dataset can be low. The plan serves the week’s column total beside it.',
        ref: 'plan 2026-09-21 Task 9',
      },
    ],
  },
  {
    slug: 'mesa',
    label: 'MESA savings',
    domain: 'pay',
    status: 'planned',
    summary: 'Each member’s MESA savings balance and deposits.',
    sources: ['mesa_accounts', 'mesa_ledger'],
    sensitivity: 'money',
    grain: 'One row per member account.',
    leavers: 'Included while a balance is held.',
    fields: [
      f('work_email', 'contact', 'Company email'),
      f('member_since', 'time', 'Opt-in effective date'),
      f('balance', 'money', 'Current balance', true),
      f('last_deposit', 'time', 'Last Friday deposit'),
      f('status', 'status', 'Membership status'),
    ],
    neverServed: ['request receipts', 'notes'],
    caveats: [],
  },

  // ── Banking ─────────────────────────────────────────────────────────────────
  {
    slug: 'bank-info',
    label: 'Bank info',
    domain: 'banking',
    status: 'planned',
    summary: 'How each person is paid: payment method, bank, last four digits, and whether anything is missing.',
    sources: ['src/lib/people/people-banking.ts over employee_ids, disbursement_records'],
    sensitivity: 'restricted',
    grain: 'One row per person.',
    leavers: 'Hidden.',
    fields: [
      f('work_email', 'contact', 'Company email'),
      f('payout_method', 'banking', 'The rail Payment Dispatch pays on: bank, Wise, wallet …'),
      f('bank_name', 'banking', 'Bank name'),
      f('account_last4', 'banking', 'Last four digits, only when the payout method is a bank'),
      f('bank_info_complete', 'status', 'False when payout details are missing'),
    ],
    neverServed: [
      'account_number',
      'routing_number',
      'swift_code',
      'account_holder_name',
      'alt_account_number',
      'alt_routing_number',
      'hurupay_email',
      'full_address',
    ],
    caveats: [
      {
        kind: 'open',
        text: 'The public anon key, which ships in the login page’s JavaScript, reads every column of employee_ids today: 1,009 full account numbers with holder names. Nothing on this page is true for the anon key until that policy is removed. Measured 2026-09-25, not fixed.',
        ref: 'Audit item 221 · memory anon-key-reads-bank-accounts',
      },
      {
        kind: 'note',
        text: 'Full numbers will never leave by an integration key (Kane, 2026-09-25). Inside the HRIS they are shown one person at a time, and every reveal is audited.',
        ref: 'app/api/people/[email]/reveal-banking/route.ts',
      },
      {
        kind: 'note',
        text: 'Must use the same resolver Payment Dispatch routes by. The receiving account and the send-from bank are different things.',
        ref: 'memory wallet-rail-mirror-and-lock',
      },
    ],
  },

  // ── Performance ─────────────────────────────────────────────────────────────
  {
    slug: 'kpi-scores',
    label: 'KPI & QC scores',
    domain: 'performance',
    status: 'planned',
    summary: 'Weekly KPI and QC scores per person.',
    sources: ['qc_kpi_submissions', 'qc_review_status'],
    sensitivity: 'low',
    grain: 'One row per person per scored week.',
    leavers: 'Included for the weeks they were scored.',
    fields: [
      f('work_email', 'contact', 'Company email'),
      f('week', 'time', 'Scored week (a Sunday)'),
      f('department', 'work', 'Department scored in'),
      f('score', 'work', 'KPI score'),
      f('qc_status', 'status', 'QC review state'),
    ],
    neverServed: ['reviewer comments'],
    caveats: [
      {
        kind: 'note',
        text: 'A scored week is keyed on its Sunday. A Monday key once manufactured 10 phantom QC weeks; the route now refuses one.',
        ref: 'memory qc-period-key-must-be-sunday',
      },
    ],
  },

  // ── Never offered ───────────────────────────────────────────────────────────
  {
    slug: 'secrets-and-settings',
    label: 'Settings & secrets',
    domain: 'never',
    status: 'never',
    summary: 'Keys, webhook URLs, force-logout maps and payroll wizard state.',
    sources: ['app_settings'],
    sensitivity: 'restricted',
    reason: 'Credentials and in-flight payroll. One leaked value opens everything else.',
    caveats: [],
  },
  {
    slug: 'one-time-codes',
    label: 'One-time codes',
    domain: 'never',
    status: 'never',
    summary: 'The OTPs behind the bank-update and gift-address links.',
    sources: ['bank_update_otps', 'gift_address_otps'],
    sensitivity: 'restricted',
    reason: 'A code is a login. Reading one is signing in as that person.',
    caveats: [],
  },
  {
    slug: 'api-keys-and-logs',
    label: 'API keys & audit trail',
    domain: 'never',
    status: 'never',
    summary: 'The integration client list, its request log, and the audit log.',
    sources: ['external_api_clients', 'external_api_requests', 'audit_log'],
    sensitivity: 'restricted',
    reason: 'The record of who read what must not be readable by the readers.',
    caveats: [],
  },
  {
    slug: 'conversations',
    label: 'Conversations',
    domain: 'never',
    status: 'never',
    summary: 'Support chat, support tickets’ messages, and Penny transcripts.',
    sources: ['employee_support_chat_messages', 'employee_support_messages', 'ceo_chat_feedback'],
    sensitivity: 'restricted',
    reason: 'People write things to support they would not put on a roster.',
    caveats: [],
  },
  {
    slug: 'documents',
    label: 'Documents & signatures',
    domain: 'never',
    status: 'never',
    summary: 'Onboarding submissions, contracts, signatures, termination letters, medical records.',
    sources: ['hr_onboarding_submissions', 'document_signatures', 'termination_documents'],
    sensitivity: 'restricted',
    reason: 'Government IDs, signatures and medical detail. They stay inside the HRIS.',
    caveats: [],
  },
  {
    slug: 'access-and-presence',
    label: 'Permissions & presence',
    domain: 'never',
    status: 'never',
    summary: 'Who can see whom, and who is online right now.',
    sources: ['employee_feature_permissions', 'user_presence'],
    sensitivity: 'restricted',
    reason: 'The access map is a target list, and presence tells an outsider when someone is away.',
    caveats: [],
  },
];

// ─── Lookups ──────────────────────────────────────────────────────────────────

export function isLive(d: Dataset): d is LiveDataset {
  return d.status === 'live';
}

export const LIVE_DATASETS: readonly LiveDataset[] = DATASETS.filter(isLive);

export function datasetBySlug(slug: string): Dataset | undefined {
  return DATASETS.find((d) => d.slug === slug);
}

export function datasetsIn(domain: DatasetDomain): Dataset[] {
  return DATASETS.filter((d) => d.domain === domain);
}

export const STATUS_LABELS: Record<DatasetStatus, string> = {
  live: 'Live',
  planned: 'Planned',
  never: 'Never offered',
};
