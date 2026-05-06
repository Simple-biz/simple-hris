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
}

// ── Department keys ──────────────────────────────────────────────────────────

export const HSL_DEPT_KEYS = [
  'ssd_medical_records',
  'care_team',
  'case_manager',
  'filing_specialist',
  'intake_specialist',
  'post_hearing_prep',
  'collections',
  'healthcare_team_lead',
  'collections_tl',
  'chelzy_asst',
  'vicky_asst_tl',
  'case_mgmt_asst_tl',
  'case_mgr_no_kpi',
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
    cadence: 'weekly',
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

  case_manager: {
    key: 'case_manager',
    name: 'Case Manager',
    cadence: 'weekly',
    color: '#8b5cf6',
    headerBg: 'bg-violet-950/40',
    badgeCls: 'bg-violet-900/60 text-violet-300',
    rules: [
      { type: 'per_unit', key: 'five_star_reviews',   label: '5-Star Reviews',      rate: 250 },
      { type: 'per_unit', key: 'rfc_form',            label: 'RFC Form',             rate: 250 },
      { type: 'per_unit', key: 'portal_login',        label: 'Portal Login',         rate: 100 },
      { type: 'per_unit', key: 'dme_prescriptions',   label: 'DME Prescriptions',    rate: 250 },
      { type: 'per_unit', key: 'completed_tasks',     label: 'Completed Tasks',      rate: 250 },
      { type: 'per_unit', key: 'converted_referral',  label: 'Converted Referral',   rate: 250 },
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
    name: 'Post-Hearing Prep Team',
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

  chelzy_asst: {
    key: 'chelzy_asst',
    name: "Chelzy's Assistant",
    cadence: 'monthly',
    color: '#71717a',
    headerBg: 'bg-zinc-800/60',
    badgeCls: 'bg-zinc-700/60 text-zinc-300',
    rules: [
      { type: 'flat', key: 'monthly_flat', label: 'Monthly Flat ($10 USD)', amount: 10, currency: 'USD' },
    ],
  },

  vicky_asst_tl: {
    key: 'vicky_asst_tl',
    name: "Vicky's Asst TL",
    cadence: 'monthly',
    color: '#64748b',
    headerBg: 'bg-slate-800/60',
    badgeCls: 'bg-slate-700/60 text-slate-300',
    rules: [
      { type: 'flat', key: 'monthly_flat', label: 'Monthly Flat Bonus', amount: 2500 },
    ],
  },

  case_mgmt_asst_tl: {
    key: 'case_mgmt_asst_tl',
    name: 'Case Mgmt Asst Team Leader',
    cadence: 'monthly',
    color: '#78716c',
    headerBg: 'bg-stone-800/60',
    badgeCls: 'bg-stone-700/60 text-stone-300',
    noKpi: true,
    rules: [],
  },

  case_mgr_no_kpi: {
    key: 'case_mgr_no_kpi',
    name: 'Case Manager (No KPI)',
    cadence: 'weekly',
    color: '#a3a3a3',
    headerBg: 'bg-neutral-800/60',
    badgeCls: 'bg-neutral-700/60 text-neutral-300',
    noKpi: true,
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
  return `₱${Math.round(amount).toLocaleString('en-PH')}`;
}
