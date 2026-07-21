// HSL Bonus Calculator — schema-driven department configs.
// Every department's rules are declared here; the calculation engine
// handles all of them with no department-specific branching.

export type PeriodType = 'weekly' | 'monthly';
export type BonusStatus = 'draft' | 'ready' | 'locked';
export type SubTeamName = 'BLUE' | 'GREEN' | 'YELLOW' | 'ORANGE' | 'PURPLE' | 'RED';

// ── Rule shapes ──────────────────────────────────────────────────────────────

export interface PerUnitRule {
  type: 'per_unit';
  key: string;
  label: string;
  rate: number;      // PHP (or USD if currency = 'USD')
  currency?: 'PHP' | 'USD';
  managerOnly?: boolean;
}

export interface TieredBand {
  min: number;
  max: number | null;  // null = unbounded
  rate: number;        // PHP per unit
}

export interface TieredRule {
  type: 'tiered';
  key: string;
  label: string;
  tiers: TieredBand[];
}

export interface FlatRule {
  type: 'flat';
  key: string;
  label: string;
  amount: number;
  currency?: 'PHP' | 'USD';
  managerOnly?: boolean;
}

export interface TeamSplitThreshold {
  minPct: number;   // inclusive lower bound (%)
  maxPct: number | null;
  ratePerRecord: number;  // PHP
}

export interface TeamSplitRule {
  type: 'team_split';
  key: string;
  label: string;
  thresholds: TeamSplitThreshold[];
  subTeams: SubTeamName[];
}

export type BonusRule = PerUnitRule | TieredRule | FlatRule | TeamSplitRule;

// ── Department config ────────────────────────────────────────────────────────

export interface DeptConfig {
  key: HslDeptKey;
  name: string;
  cadence: PeriodType;
  color: string;           // hex — used for left border
  headerBg: string;        // tailwind bg class
  badgeCls: string;        // tailwind badge classes
  rules: BonusRule[];
  monthlyMax?: number;     // PHP cap per employee
  noKpi?: boolean;         // roster-only, no inputs
  // Per-employee bespoke incentive sets (the "Managers Weekly" dept): each person
  // has their own hardcoded checklist of components rather than uniform dept rules.
  // The component sets live in HSL_MANAGERS; scoring uses calcManagerBonus.
  perEmployee?: boolean;
}

// ── Department keys ──────────────────────────────────────────────────────────

export const HSL_DEPT_KEYS = [
  'ssd_medical_records',
  'medical_records',
  'care_team',
  'callback_team',
  'simple_texting',
  'filing_specialist',
  'intake_specialist',
  'post_hearing_prep',
  'collections',
  'healthcare_team_lead',
  'collections_tl',
  'hsl_managers',
] as const;

export type HslDeptKey = (typeof HSL_DEPT_KEYS)[number];

// Namespaced strings stored in department_managers table for access control.
// A manager with 'hogan_smith_law' or 'hsl' sees all sub-depts.
export function hslAccessKey(deptKey: HslDeptKey): string {
  return `hsl:${deptKey}`;
}

// Whether a manager's department list grants access to a specific sub-dept.
// Only explicit hsl:<key> grants count — the parent "Hogan Smith Law" assignment
// gates whether sub-dept assignment is even possible (in admin UI), but it does
// not implicitly grant every sub-dept. Admins must tick each sub-dept explicitly.
export function canAccessHslDept(
  managedDepts: string[],
  deptKey: HslDeptKey,
  isElevated: boolean,
): boolean {
  if (isElevated) return true;
  const lower = managedDepts.map((d) => d.toLowerCase());
  return lower.includes(hslAccessKey(deptKey).toLowerCase());
}

// ── Department configurations ────────────────────────────────────────────────

export const HSL_DEPTS: Record<HslDeptKey, DeptConfig> = {
  ssd_medical_records: {
    key: 'ssd_medical_records',
    name: 'SSD Medical Records',
    cadence: 'monthly',
    color: '#10b981',
    headerBg: 'bg-emerald-950/40',
    badgeCls: 'bg-emerald-900/60 text-emerald-300',
    rules: [
      {
        type: 'team_split',
        key: 'team_split',
        label: 'Team Accuracy Bonus',
        thresholds: [
          { minPct: 0,   maxPct: 89.99, ratePerRecord: 0 },
          { minPct: 90,  maxPct: 94.99, ratePerRecord: 250 },
          { minPct: 95,  maxPct: null,  ratePerRecord: 350 },
        ],
        subTeams: ['BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'PURPLE', 'RED'],
      },
    ],
  },

  medical_records: {
    key: 'medical_records',
    name: 'Medical Records',
    cadence: 'weekly',
    color: '#06b6d4',
    headerBg: 'bg-cyan-950/40',
    badgeCls: 'bg-cyan-900/60 text-cyan-300',
    rules: [
      { type: 'per_unit', key: 'portal_login', label: 'Patient Portal Log Ins', rate: 250 },
      { type: 'flat',     key: 'rfc_form',     label: 'RFC',                     amount: 250 },
    ],
  },

  care_team: {
    key: 'care_team',
    name: 'Care Team',
    cadence: 'weekly',
    color: '#3b82f6',
    headerBg: 'bg-blue-950/40',
    badgeCls: 'bg-blue-900/60 text-blue-300',
    rules: [
      { type: 'per_unit', key: 'church_attendees', label: 'Church Attendees', rate: 50 },
    ],
  },

  callback_team: {
    key: 'callback_team',
    name: 'Callback Team',
    cadence: 'weekly',
    color: '#0ea5e9',
    headerBg: 'bg-sky-950/40',
    badgeCls: 'bg-sky-900/60 text-sky-300',
    rules: [
      { type: 'per_unit', key: 'transferred_calls',      label: 'Successfully Transferred Calls',    rate: 50 },
      { type: 'per_unit', key: 'signups_from_transfers', label: 'Sign ups from Transferred Calls',   rate: 250 },
    ],
  },

  simple_texting: {
    key: 'simple_texting',
    name: 'Simple Texting',
    cadence: 'weekly',
    color: '#d946ef',
    headerBg: 'bg-fuchsia-950/40',
    badgeCls: 'bg-fuchsia-900/60 text-fuchsia-300',
    rules: [
      { type: 'per_unit', key: 'transferred_calls', label: 'Successfully Transferred Calls', rate: 50 },
      { type: 'per_unit', key: 'sign_ups',          label: 'Sign Ups',                       rate: 250 },
    ],
  },

  filing_specialist: {
    key: 'filing_specialist',
    name: 'Filing Specialist',
    cadence: 'weekly',
    color: '#f97316',
    headerBg: 'bg-orange-950/40',
    badgeCls: 'bg-orange-900/60 text-orange-300',
    rules: [
      { type: 'per_unit', key: 'portal_login',      label: 'Patient Portal Login', rate: 100 },
      { type: 'per_unit', key: 'bbb_reviews',       label: 'BBB Reviews',        rate: 250 },
      {
        type: 'tiered',
        key: 'attested_cases',
        label: 'Attested Cases',
        tiers: [
          { min: 0,  max: 29, rate: 0 },
          { min: 30, max: 39, rate: 50 },
          { min: 40, max: 49, rate: 75 },
          { min: 50, max: null, rate: 100 },
        ],
      },
      { type: 'per_unit', key: 'converted_referral', label: 'Converted Referral', rate: 250 },
    ],
  },

  intake_specialist: {
    key: 'intake_specialist',
    name: 'Intake Specialist',
    cadence: 'weekly',
    color: '#14b8a6',
    headerBg: 'bg-teal-950/40',
    badgeCls: 'bg-teal-900/60 text-teal-300',
    rules: [
      { type: 'per_unit', key: 'signed_rep_docs',   label: 'Signed Rep Docs',    rate: 250 },
      { type: 'per_unit', key: 'five_star_reviews',  label: '5-Star Reviews',     rate: 100 },
    ],
  },

  post_hearing_prep: {
    key: 'post_hearing_prep',
    name: 'Pre-Hearing / Post-Hearing Prep',
    cadence: 'weekly',
    color: '#6366f1',
    headerBg: 'bg-indigo-950/40',
    badgeCls: 'bg-indigo-900/60 text-indigo-300',
    monthlyMax: 3500,
    rules: [
      { type: 'per_unit', key: 'five_star_survey', label: '5-Star Survey', rate: 250 },
      { type: 'per_unit', key: 'portal_login',     label: 'Portal Login',  rate: 100 },
    ],
  },

  collections: {
    key: 'collections',
    name: 'Collections',
    cadence: 'monthly',
    color: '#f59e0b',
    headerBg: 'bg-amber-950/40',
    badgeCls: 'bg-amber-900/60 text-amber-300',
    rules: [
      { type: 'flat',     key: 'monthly_flat',      label: 'Monthly Flat Bonus',   amount: 2500, managerOnly: true },
      { type: 'per_unit', key: 'converted_referral', label: 'Converted Referral',  rate: 250 },
    ],
  },

  healthcare_team_lead: {
    key: 'healthcare_team_lead',
    name: 'Healthcare Team Lead',
    cadence: 'monthly',
    color: '#f43f5e',
    headerBg: 'bg-rose-950/40',
    badgeCls: 'bg-rose-900/60 text-rose-300',
    rules: [
      { type: 'per_unit', key: 'aca_signups', label: 'ACA Signups', rate: 250 },
    ],
  },

  collections_tl: {
    key: 'collections_tl',
    name: 'Collections Team Leader',
    cadence: 'monthly',
    color: '#d97706',
    headerBg: 'bg-amber-950/30',
    badgeCls: 'bg-amber-900/50 text-amber-200',
    rules: [
      { type: 'flat', key: 'monthly_flat', label: 'Monthly Flat Bonus', amount: 2500 },
    ],
  },

  hsl_managers: {
    key: 'hsl_managers',
    name: 'Managers Weekly',
    cadence: 'weekly',
    color: '#a855f7',
    headerBg: 'bg-purple-950/40',
    badgeCls: 'bg-purple-900/60 text-purple-300',
    // Bespoke per-manager incentive sets — see HSL_MANAGERS / calcManagerBonus.
    // No uniform rules; the calculator renders each manager's own checklist.
    perEmployee: true,
    rules: [],
  },
};

// ── Calculation engine ───────────────────────────────────────────────────────

export type KpiData = Record<string, number | boolean>;

export function calcBonus(
  kpiData: KpiData,
  dept: DeptConfig,
  isManager: boolean,
): number {
  let total = 0;
  for (const rule of dept.rules) {
    if (rule.type === 'per_unit') {
      if (rule.managerOnly && !isManager) continue;
      const n = Number(kpiData[rule.key] ?? 0);
      total += n * rule.rate;
    } else if (rule.type === 'tiered') {
      const n = Number(kpiData[rule.key] ?? 0);
      const band = rule.tiers.find(
        (t) => n >= t.min && (t.max === null || n <= t.max),
      );
      if (band) total += n * band.rate;
    } else if (rule.type === 'flat') {
      if (rule.managerOnly && !isManager) continue;
      if (kpiData[rule.key]) total += rule.amount;
    }
    // team_split is calculated at the sub-team level, not per-employee here
  }
  if (dept.monthlyMax !== undefined) total = Math.min(total, dept.monthlyMax);
  return total;
}

export function calcTeamSplitShare(
  pct: number,
  records: number,
  memberCount: number,
  rule: TeamSplitRule,
): number {
  if (memberCount <= 0) return 0;
  const threshold = rule.thresholds.find(
    (t) => pct >= t.minPct && (t.maxPct === null || pct <= t.maxPct),
  );
  if (!threshold || threshold.ratePerRecord === 0) return 0;
  return (records * threshold.ratePerRecord) / memberCount;
}

export function formatPeso(amount: number, currency: 'PHP' | 'USD' = 'PHP'): string {
  if (currency === 'USD') return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  // Always show centavos so a fractional bonus (e.g. a team-split share divided
  // across members) is never silently rounded to whole pesos in the display.
  return `₱${amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Managers Weekly — bespoke per-manager incentives ──────────────────────────
// The "Managers Weekly" dept (key: hsl_managers) is the one dept whose scoring
// differs per person: each manager has their own hardcoded checklist of incentive
// components, each a fixed PHP amount earned when ticked. Amounts are sourced from
// docs/reference/managers-logic.md (the "Julie" sheet).
//
// Deliberately NOT modeled here: the per-manager "Attendance" (₱5,000) and
// "Tech Allowance" (₱1,850) lines from that sheet — those are already paid by the
// Perfect-Attendance (PAB) + Technology bonus engine, so including them here would
// double-pay. Cumulative tiers are expressed as independent checkboxes: hitting a
// higher tier means the scorer ticks every lower tier too (they SUM), matching the
// sheet's =SUM(...) totals (e.g. Andre "< 2 Days" ⇒ <3 + <2.5 + <2 ⇒ ₱7,500).
// Monthly components (cadence: 'monthly') are ticked only in the final payroll
// week of the month.

export interface ManagerComponent {
  key: string;
  label: string;
  amount: number;                  // PHP earned when this component is ticked
  cadence?: 'weekly' | 'monthly';  // 'monthly' → earned in the last week of the month
}

export interface HslManagerSpec {
  email: string;
  name: string;
  components: ManagerComponent[];
}

export const HSL_MANAGERS: HslManagerSpec[] = [
  {
    email: 'gyd@simple.biz',
    name: 'Tura, Gyd',
    components: [
      { key: 'monthly_bonus', label: 'Monthly Bonus (last week of the month)', amount: 25000, cadence: 'monthly' },
    ],
  },
  {
    email: 'eulap@simple.biz',
    name: 'Pacheco, Eula Jane J.',
    components: [
      { key: 'csm_9000',    label: '> 9,000 Outbound Case Status Messages',  amount: 2500 },
      { key: 'csm_12500',   label: '> 12,500 Outbound Case Status Messages', amount: 1250 },
      { key: 'rfc_dme_75',  label: '75 or More RFCs and DME',                amount: 2500 },
      { key: 'rfc_dme_100', label: '100 or More RFCs and DME',              amount: 1250 },
    ],
  },
  {
    email: 'andret@simple.biz',
    name: 'Tolentino, Romel T. "Andre"',
    components: [
      { key: 'awaiting_3',   label: 'New Clients Awaiting Filing < 3 Days',   amount: 5000 },
      { key: 'awaiting_2_5', label: 'New Clients Awaiting Filing < 2.5 Days', amount: 1250 },
      { key: 'awaiting_2',   label: 'New Clients Awaiting Filing < 2 Days',   amount: 1250 },
    ],
  },
  {
    email: 'veec@simple.biz',
    name: 'Mortos, Veronela Clarissa "Vee"',
    components: [
      { key: 'incomplete_5',  label: 'Hearing with Incomplete Medical Records < 5%',  amount: 2500 },
      { key: 'incomplete_10', label: 'Hearing with Incomplete Medical Records < 10%', amount: 2500 },
    ],
  },
  {
    email: 'emss@simple.biz',
    name: 'Solon, Emily "Ems"',
    components: [
      { key: 'monthly_perf', label: 'Monthly Performance Bonus', amount: 2500, cadence: 'monthly' },
    ],
  },
  {
    email: 'stara@simple.biz',
    name: 'Abella, Esterlita I. "Star"',
    components: [
      { key: 'monthly_perf', label: 'Monthly Performance Bonus', amount: 2500, cadence: 'monthly' },
    ],
  },
  {
    email: 'jazzr@simple.biz',
    name: 'Redulla, Jazz',
    components: [
      { key: 'monthly_perf', label: 'Monthly Performance Bonus', amount: 2500, cadence: 'monthly' },
    ],
  },
  {
    email: 'mariely@simple.biz',
    name: 'Yungco, Marielace "Mariel" Buena Fe',
    components: [
      { key: 'closes_30',       label: 'Closes over 30% of overall leads',   amount: 2500 },
      { key: 'form_response_1', label: 'Average Form Response < 1.0 Minutes', amount: 2500 },
    ],
  },
  {
    email: 'dana@simple.biz',
    name: 'Abad, Danilo Jr "Dan"',
    components: [
      { key: 'closes_30',       label: 'Closes over 30% of overall leads',   amount: 2500 },
      { key: 'form_response_1', label: 'Average Form Response < 1.0 Minutes', amount: 2500 },
    ],
  },
  {
    email: 'juliec@simple.biz',
    name: 'Julie Credo',
    components: [
      { key: 'closes_30',       label: 'Closes over 30% of overall leads',   amount: 1250 },
      { key: 'form_response_1', label: 'Average Form Response < 1.0 Minutes', amount: 1250 },
    ],
  },
  {
    email: 'jayh@simple.biz',
    name: 'John Michael Hernandez',
    components: [
      { key: 'closes_30',       label: 'Closes over 30% of overall leads',   amount: 1250 },
      { key: 'form_response_1', label: 'Average Form Response < 1.0 Minutes', amount: 1250 },
    ],
  },
];

export const HSL_MANAGERS_BY_EMAIL: Record<string, HslManagerSpec> =
  Object.fromEntries(HSL_MANAGERS.map((m) => [m.email.toLowerCase(), m]));

/** Sum a manager's ticked incentive components. Unknown emails (e.g. an external
 *  member added to the Managers dept) have no components and score ₱0.
 *
 *  `includeMonthly` (default true) controls whether monthly-cadence components
 *  (e.g. Gyd's ₱25,000 monthly bonus) are counted. The calculator's live display
 *  keeps the default (managers see their full potential); the payroll dispatch
 *  path passes `false` outside the final payroll week of the month so a monthly
 *  bonus pays exactly once, in the final week — matching how PAB/catalog monthly
 *  bonuses behave. */
export function calcManagerBonus(
  email: string,
  kpiData: KpiData,
  opts?: { includeMonthly?: boolean },
): number {
  const spec = HSL_MANAGERS_BY_EMAIL[email.toLowerCase()];
  if (!spec) return 0;
  const includeMonthly = opts?.includeMonthly ?? true;
  let total = 0;
  for (const c of spec.components) {
    if (c.cadence === 'monthly' && !includeMonthly) continue;
    if (kpiData[c.key]) total += c.amount;
  }
  return total;
}
