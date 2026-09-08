// HSL Bonus Calculator — schema-driven department configs.
// Every department's rules are declared here; the calculation engine
// handles all of them with no department-specific branching.

import { isFinalPayrollWeekOfMonth } from '../payroll/bonus-cadence';

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
  /** 'monthly' → a once-a-month bonus inside a WEEKLY dept: the calculator only
   *  lets the scorer tick it in the final payroll week of the month, and
   *  `calcBonus` drops it for any other week it is told about. */
  cadence?: 'monthly';
  /** Paid ON TOP of `monthlyMax` instead of inside it — a fixed monthly bonus
   *  must not eat the weekly KPI cap (or be eaten by it). */
  exemptFromMonthlyMax?: boolean;
}

/** A raw peso amount the manager types in directly. The typed number IS the
 *  amount added to the bonus — no rate, no multiplication. */
export interface ManualRule {
  type: 'manual';
  key: string;
  label: string;
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

/** A flat per-record rate pooled across a sub-team and split evenly across its
 *  members — no accuracy tiering (unlike TeamSplitRule). e.g. RFC: team logs N
 *  RFCs this period, pool = N × ratePerRecord, each member gets pool / headcount. */
export interface TeamPoolRule {
  type: 'team_pool';
  key: string;
  label: string;
  ratePerRecord: number;  // PHP
  subTeams: SubTeamName[];
}

export type BonusRule = PerUnitRule | TieredRule | FlatRule | ManualRule | TeamSplitRule | TeamPoolRule;

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
  // A MONTHLY dept whose Ready/Locked period is auto-dispatched in the payroll week
  // it was scored for, summed with the person's weekly HSL amounts (Carla,
  // 2026-09-08: SSD "is a monthly payment", "typically processed in the first week
  // of the month", that must be "combined with the weekly bonus" — the manager's
  // Ready is the trigger, not the calendar). Without it a monthly dept stays MANUAL
  // via Adjustment — opting a dept in is a pay decision, pinned by test. See
  // hslDeptAutoDispatches.
  monthlyAutoPay?: boolean;
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
  'filing_specialist',
  'intake_specialist',
  'post_hearing_prep',
  'collections',
  'healthcare_team_lead',
  'attestation',
  'case_managers',
  'executive_guest_services',
  'executive_assistants',
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
    monthlyAutoPay: true,
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
      {
        type: 'team_pool',
        key: 'rfc_pool',
        label: 'RFC',
        ratePerRecord: 250,
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
      { type: 'per_unit', key: 'portal_login', label: 'Patient Portal Log Ins', rate: 100 },
      { type: 'manual',   key: 'rfc_form',     label: 'RFC' },
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
      // Carla (2026-09-08): "They have a monthly bonus of 2500 … a checkbox that
      // applies 2500 when checked." One tick per person per month, in the final
      // payroll week only, and OUTSIDE the ₱3,500 weekly KPI cap — a fixed ₱2,500
      // under a ₱3,500 cap would otherwise leave ₱1,000 of KPI room that month.
      { type: 'flat', key: 'monthly_bonus', label: 'Monthly Bonus', amount: 2500, cadence: 'monthly', exemptFromMonthlyMax: true },
    ],
  },

  collections: {
    key: 'collections',
    name: 'Collections',
    cadence: 'monthly',
    // Carla (2026-09-08): the Collections monthly flat "fails to come through" —
    // 30 people ticked, ₱77,000 in the 08-30 period, never auto-dispatched. Same
    // class as SSD: a monthly dept pays in the week its period is marked Ready.
    monthlyAutoPay: true,
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

  attestation: {
    key: 'attestation',
    name: 'Attestation',
    cadence: 'weekly',
    color: '#84cc16',
    headerBg: 'bg-lime-950/40',
    badgeCls: 'bg-lime-900/60 text-lime-300',
    // Manager sheet formula (2026-08-24 — the two additive terms are NEW; the
    // tiered bands are byte-identical to the 2026-07-27 correction):
    //   =IF(Cases>=50,Cases*100,IF(Cases>=35,Cases*75,IF(Cases>=25,Cases*50,0)))
    //     + (Referral Leads * 250) + (SSA.Gov * 250)
    // The tier lands on the CASE COUNT ONLY — referral leads and SSA.Gov never
    // push a scorer into a higher band, and they pay in full even when cases
    // fall below 25 and the tiered term is ₱0. Pinned by schema.test.ts.
    rules: [
      {
        type: 'tiered',
        key: 'attested_cases',
        label: 'Attested Cases',
        // =IF(Cases>=50,Cases*100,IF(Cases>=35,Cases*75,IF(Cases>=25,Cases*50,0)))
        tiers: [
          { min: 0,  max: 24, rate: 0 },
          { min: 25, max: 34, rate: 50 },
          { min: 35, max: 49, rate: 75 },
          { min: 50, max: null, rate: 100 },
        ],
      },
      { type: 'per_unit', key: 'referral_leads', label: 'Referral Leads', rate: 250 },
      { type: 'per_unit', key: 'ssa_gov',        label: 'SSA.Gov',        rate: 250 },
    ],
  },

  case_managers: {
    key: 'case_managers',
    name: 'Case Managers',
    cadence: 'weekly',
    color: '#eab308',
    headerBg: 'bg-yellow-950/40',
    badgeCls: 'bg-yellow-900/60 text-yellow-300',
    // =(Reviews*250)+(RFC*250)+(PPL*100)+(DME*250)+(Task*250)+(Referral Leads*250)
    rules: [
      { type: 'per_unit', key: 'reviews',        label: 'Reviews',        rate: 250 },
      { type: 'per_unit', key: 'rfc',            label: 'RFC',            rate: 250 },
      { type: 'per_unit', key: 'ppl',            label: 'PPL',            rate: 100 },
      { type: 'per_unit', key: 'dme',            label: 'DME',            rate: 250 },
      { type: 'per_unit', key: 'task',           label: 'Task',           rate: 250 },
      { type: 'per_unit', key: 'referral_leads', label: 'Referral Leads', rate: 250 },
      // 2026-09-08 (Carla via Kane: "SSA.GOV*250"): a seventh additive term, the same
      // shape as Attestation's. Not retroactive — rows saved without the key read 0.
      { type: 'per_unit', key: 'ssa_gov',        label: 'SSA.Gov',        rate: 250 },
    ],
  },

  executive_guest_services: {
    key: 'executive_guest_services',
    name: 'Executive Guest Services',
    cadence: 'weekly',
    color: '#ec4899',
    headerBg: 'bg-pink-950/40',
    badgeCls: 'bg-pink-900/60 text-pink-300',
    // Roster-only (Kane, 2026-08-14): a real ~31-person Hogan cohort that was
    // scored nowhere (29 hsl_team_members rows sat at dept_key=NULL). No KPI
    // bonus program has been defined for it, and scoring rules are never
    // guessed — they change pay. When Carla supplies the rules, add them here
    // and drop `noKpi`; the card, readiness row and dispatch derive on their own.
    rules: [],
    noKpi: true,
  },

  executive_assistants: {
    key: 'executive_assistants',
    name: 'Executive Assistants',
    cadence: 'weekly',
    color: '#c084fc',
    headerBg: 'bg-fuchsia-950/40',
    badgeCls: 'bg-fuchsia-900/60 text-fuchsia-300',
    // Roster-only (Kane, 2026-08-14): "Lets create a new department called
    // HSL - Executive Assistants and put them in there please". The cohort is
    // the three EA/assistant roles the bulk sub-department assignment could not
    // map to any existing team — "Dan Smith EA", "Dan Smith EA- Med Rec" and
    // "Rick's Assistant" (docs/features/hsl-subdepartments.md §9). No KPI bonus
    // program has been defined for them and scoring rules are never guessed,
    // so this takes §7a-roster-only exactly like executive_guest_services:
    // `noKpi` keeps Payroll Readiness at 'no_bonus' instead of a permanent
    // weekly 'draft'. When Carla supplies rules, add them here and drop noKpi.
    //
    // NOT to be confused with the BARE `executive_assistants` slug, which is a
    // separate in-app registry department whose calculator card was retired
    // (department-bonus.ts KPI_CALCULATOR_RETIRED_DEPT_KEYS). That set holds
    // unnamespaced slugs; this key only ever appears as `hsl:executive_assistants`,
    // so the two never meet — pinned by a test.
    rules: [],
    noKpi: true,
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

// ── HSL sub-department normalization ─────────────────────────────────────────

/**
 * Recognizes a raw `Department` string (from `global_master_list`) as one of
 * the 14 `HSL_DEPT_KEYS` branches, two ways:
 *   - The namespaced access-key form Department Transfers already write into
 *     the master list (`hsl:case_managers`) — validated against
 *     `HSL_DEPT_KEYS`, not just prefix-stripped.
 *   - The branch's plain display name (`HSL_DEPTS[key].name`), trimmed and
 *     matched case-insensitively (`"Case Managers"`, `"SSD Medical Records"`).
 *
 * Returns null for anything else — including the generic `"HSL"` / `"Hogan
 * Smith Law"` / `"Hogan"` tags, which identify someone as Hogan Smith Law at
 * the payroll-department level but don't say which specific branch.
 *
 * NOTE: the plain-display-name arm is NOT sufficient on its own to treat
 * someone as HSL. `mergeHslRoster` additionally requires `normalizeDeptToKey`
 * to agree, which by Kane's 2026-08-19 ruling admits only the namespaced
 * `hsl:<key>` form — a bare label is not a placement
 * (`hsl-subdepartments.md` §1). Keep this function's display-name matching
 * (it is what makes the namespaced/renamed cases legible), but never wire it
 * into a pay path as a membership test.
 */
export function matchHslSubDeptKey(raw: string | null | undefined): HslDeptKey | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('hsl:')) {
    const candidate = s.slice(4);
    return (HSL_DEPT_KEYS as readonly string[]).includes(candidate)
      ? (candidate as HslDeptKey)
      : null;
  }
  for (const key of HSL_DEPT_KEYS) {
    if (HSL_DEPTS[key].name.trim().toLowerCase() === s) return key;
  }
  return null;
}

// ── Calculation engine ───────────────────────────────────────────────────────

export type KpiData = Record<string, number | boolean>;

export function calcBonus(
  kpiData: KpiData,
  dept: DeptConfig,
  isManager: boolean,
  /** The week being scored (ISO period_start). When given, a `cadence: 'monthly'`
   *  flat rule pays only in the final payroll week of its month; when absent the
   *  tick is honoured as saved (the wizard pays the STORED calculated_bonus and
   *  never recomputes a per-unit dept, so this gate lives at scoring time). */
  opts?: { periodStart?: string },
): number {
  let total = 0;
  let exempt = 0;
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
      if (!kpiData[rule.key]) continue;
      if (rule.cadence === 'monthly' && opts?.periodStart && !isFinalPayrollWeekOfMonth(opts.periodStart)) continue;
      if (rule.exemptFromMonthlyMax) exempt += rule.amount;
      else total += rule.amount;
    } else if (rule.type === 'manual') {
      if (rule.managerOnly && !isManager) continue;
      total += Number(kpiData[rule.key] ?? 0);
    }
    // team_split / team_pool are calculated at the sub-team level, not per-employee here
  }
  if (dept.monthlyMax !== undefined) total = Math.min(total, dept.monthlyMax);
  return total + exempt;
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

export function calcTeamPoolShare(
  records: number,
  memberCount: number,
  rule: TeamPoolRule,
): number {
  if (memberCount <= 0) return 0;
  return (records * rule.ratePerRecord) / memberCount;
}

/** Whether the wizard auto-dispatches this dept's Ready/Locked period in the payroll
 *  week it is keyed to (the loader pins every period to the processed Hubstaff week).
 *  Weekly depts: always. Monthly depts: only with `monthlyAutoPay` — SSD Medical
 *  Records, scored once a month in whichever week Carla's team marks it Ready. Any
 *  other monthly dept is manual via the Adjustment column, and its review card says so. */
export function hslDeptAutoDispatches(dept: DeptConfig): boolean {
  return dept.cadence === 'weekly' || dept.monthlyAutoPay === true;
}

export function formatPeso(amount: number, currency: 'PHP' | 'USD' = 'PHP'): string {
  if (currency === 'USD') return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  // Always show centavos so a fractional bonus (e.g. a team-split share divided
  // across members) is never silently rounded to whole pesos in the display.
  return `₱${amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Managers Weekly — bespoke per-manager incentives ──────────────────────────
// The "Managers Weekly" dept (key: hsl_managers) is the one dept whose scoring
// differs per person: each manager has their own hardcoded set of incentive
// components. Two component kinds:
//   - 'check'  — a fixed PHP amount earned when ticked. Cumulative tiers are
//                independent checkboxes that SUM (Andre "< 2 Days" ⇒ <3 + <2.5
//                + <2 ⇒ ₱7,500), matching the "Julie" sheet's =SUM(...) totals.
//   - 'banded' — ONE metric for the week (a count or a percentage) that lands in
//                exactly one band; only the landed band pays. The 2026-08-30
//                sheet (approved by Rob effective Aug 24 and Austin effective
//                Aug 31; Carla 2026-09-08: starts with the 8/30–9/5 week, earned
//                weekly, the scorer picks the band that applies).
// Amounts are sourced from docs/reference/managers-logic.md.
//
// Deliberately NOT modeled here: the per-manager "Attendance" (₱5,000) and
// "Tech Allowance" (₱1,850) lines from both sheets — those are already paid by
// the Perfect-Attendance (PAB) + Technology bonus engine, so including them here
// would double-pay.
//
// SPECS ARE DATED. The wizard recomputes this dept from the saved tick marks with
// the spec in code (it does NOT pay the frozen calculated_bonus like every other
// HSL dept), so overwriting a manager's components would silently re-price every
// week already paid under the old ones. A manager may therefore appear more than
// once in HSL_MANAGERS: the version with the latest `effectiveFrom` ≤ the week's
// period_start wins (`managerSpecFor`). A version with no `effectiveFrom` applies
// from the dept's creation. Never edit an existing version's components — add a
// dated one.
//
// Monthly components (cadence: 'monthly') are ticked only in the final payroll
// week of the month.

export interface ManagerBand {
  /** Inclusive lower bound of the week's achieved value. Absent = open below. */
  from?: number;
  /** Inclusive upper bound of the week's achieved value. Absent = open above. */
  to?: number;
  label: string;
  amount: number;                  // PHP paid when the week's value lands here
}

export interface ManagerCheckComponent {
  kind: 'check';
  key: string;
  label: string;
  amount: number;                  // PHP earned when this component is ticked
  cadence?: 'weekly' | 'monthly';  // 'monthly' → earned in the last week of the month
}

export interface ManagerBandedComponent {
  kind: 'banded';
  key: string;
  label: string;
  /** What the stored number counts — shown beside the band picker. */
  unit: string;
  bands: ManagerBand[];
  cadence?: 'weekly';
}

export type ManagerComponent = ManagerCheckComponent | ManagerBandedComponent;

export interface HslManagerSpec {
  email: string;
  name: string;
  /** ISO Sunday of the first payroll week this version applies to (inclusive).
   *  Absent = applies since the dept was created (2026-07-17). */
  effectiveFrom?: string;
  components: ManagerComponent[];
}

/** First payroll week scored on the 2026-08-30 manager sheet (Carla, 2026-09-08). */
export const HSL_MANAGER_SHEET_2026_08_30 = '2026-08-30';

// Intake Manager + the three Intake Team Leaders share one ladder.
const INTAKE_SIGNUP_BANDS: ManagerBand[] = [
  { from: 1500,           label: '1,500+ sign-ups',       amount: 10000 },
  { from: 1400, to: 1499, label: '1,400–1,499 sign-ups',  amount: 8000 },
  { from: 1300, to: 1399, label: '1,300–1,399 sign-ups',  amount: 6500 },
  { from: 1200, to: 1299, label: '1,200–1,299 sign-ups',  amount: 5000 },
  {             to: 1199, label: '1,199 and below',       amount: 0 },
];

export const HSL_MANAGERS: HslManagerSpec[] = [
  // ── Since 2026-07-17 (the "Julie" sheet) ────────────────────────────────────
  {
    email: 'gyd@simple.biz',
    name: 'Tura, Gyd',
    components: [
      { kind: 'check', key: 'monthly_bonus', label: 'Monthly Bonus (last week of the month)', amount: 25000, cadence: 'monthly' },
    ],
  },
  {
    email: 'eulap@simple.biz',
    name: 'Pacheco, Eula Jane J.',
    components: [
      { kind: 'check', key: 'csm_9000',    label: '> 9,000 Outbound Case Status Messages',  amount: 2500 },
      { kind: 'check', key: 'csm_12500',   label: '> 12,500 Outbound Case Status Messages', amount: 1250 },
      { kind: 'check', key: 'rfc_dme_75',  label: '75 or More RFCs and DME',                amount: 2500 },
      { kind: 'check', key: 'rfc_dme_100', label: '100 or More RFCs and DME',              amount: 1250 },
    ],
  },
  {
    email: 'andret@simple.biz',
    name: 'Tolentino, Romel T. "Andre"',
    components: [
      { kind: 'check', key: 'awaiting_3',   label: 'New Clients Awaiting Filing < 3 Days',   amount: 5000 },
      { kind: 'check', key: 'awaiting_2_5', label: 'New Clients Awaiting Filing < 2.5 Days', amount: 1250 },
      { kind: 'check', key: 'awaiting_2',   label: 'New Clients Awaiting Filing < 2 Days',   amount: 1250 },
    ],
  },
  {
    email: 'veec@simple.biz',
    name: 'Mortos, Veronela Clarissa "Vee"',
    components: [
      { kind: 'check', key: 'incomplete_5',  label: 'Hearing with Incomplete Medical Records < 5%',  amount: 2500 },
      { kind: 'check', key: 'incomplete_10', label: 'Hearing with Incomplete Medical Records < 10%', amount: 2500 },
    ],
  },
  {
    email: 'emss@simple.biz',
    name: 'Solon, Emily "Ems"',
    components: [
      { kind: 'check', key: 'monthly_perf', label: 'Monthly Performance Bonus', amount: 2500, cadence: 'monthly' },
    ],
  },
  {
    email: 'stara@simple.biz',
    name: 'Abella, Esterlita I. "Star"',
    components: [
      { kind: 'check', key: 'monthly_perf', label: 'Monthly Performance Bonus', amount: 2500, cadence: 'monthly' },
    ],
  },
  {
    email: 'jazzr@simple.biz',
    name: 'Redulla, Jazz',
    components: [
      { kind: 'check', key: 'monthly_perf', label: 'Monthly Performance Bonus', amount: 2500, cadence: 'monthly' },
    ],
  },
  {
    email: 'mariely@simple.biz',
    name: 'Yungco, Marielace "Mariel" Buena Fe',
    components: [
      { kind: 'check', key: 'closes_30',       label: 'Closes over 30% of overall leads',   amount: 2500 },
      { kind: 'check', key: 'form_response_1', label: 'Average Form Response < 1.0 Minutes', amount: 2500 },
    ],
  },
  {
    email: 'dana@simple.biz',
    name: 'Abad, Danilo Jr "Dan"',
    components: [
      { kind: 'check', key: 'closes_30',       label: 'Closes over 30% of overall leads',   amount: 2500 },
      { kind: 'check', key: 'form_response_1', label: 'Average Form Response < 1.0 Minutes', amount: 2500 },
    ],
  },
  {
    email: 'juliec@simple.biz',
    name: 'Julie Credo',
    components: [
      { kind: 'check', key: 'closes_30',       label: 'Closes over 30% of overall leads',   amount: 1250 },
      { kind: 'check', key: 'form_response_1', label: 'Average Form Response < 1.0 Minutes', amount: 1250 },
    ],
  },
  {
    email: 'jayh@simple.biz',
    name: 'John Michael Hernandez',
    components: [
      { kind: 'check', key: 'closes_30',       label: 'Closes over 30% of overall leads',   amount: 1250 },
      { kind: 'check', key: 'form_response_1', label: 'Average Form Response < 1.0 Minutes', amount: 1250 },
    ],
  },

  // ── From the 2026-08-30 week (the 2026-08-24/31 sheet) ──────────────────────
  // Gyd, Eula, Andre, Vee and Jazz Redulla are unchanged (Carla, 2026-09-08) and
  // deliberately have no dated version. Sherwin, AR and Jazmine join the cohort.
  {
    email: 'mariely@simple.biz',
    name: 'Yungco, Marielace "Mariel" Buena Fe',
    effectiveFrom: HSL_MANAGER_SHEET_2026_08_30,
    components: [
      { kind: 'banded', key: 'signups_weekly', label: 'Sign-ups this week', unit: 'sign-ups', bands: INTAKE_SIGNUP_BANDS },
    ],
  },
  {
    email: 'dana@simple.biz',
    name: 'Abad, Danilo Jr "Dan"',
    effectiveFrom: HSL_MANAGER_SHEET_2026_08_30,
    components: [
      { kind: 'banded', key: 'signups_weekly', label: 'Sign-ups this week', unit: 'sign-ups', bands: INTAKE_SIGNUP_BANDS },
    ],
  },
  {
    email: 'juliec@simple.biz',
    name: 'Credo, Julie Ann "Julie"',
    effectiveFrom: HSL_MANAGER_SHEET_2026_08_30,
    components: [
      { kind: 'banded', key: 'signups_weekly', label: 'Sign-ups this week', unit: 'sign-ups', bands: INTAKE_SIGNUP_BANDS },
    ],
  },
  {
    email: 'jayh@simple.biz',
    name: 'Hernandez, John Michael',
    effectiveFrom: HSL_MANAGER_SHEET_2026_08_30,
    components: [
      { kind: 'banded', key: 'signups_weekly', label: 'Sign-ups this week', unit: 'sign-ups', bands: INTAKE_SIGNUP_BANDS },
    ],
  },
  {
    email: 'sherwins@simple.biz',
    name: 'Santos, Sherwin',
    effectiveFrom: HSL_MANAGER_SHEET_2026_08_30,
    components: [
      {
        kind: 'banded', key: 'nurture_signups', label: 'Lead Nurture sign-ups this week', unit: 'sign-ups',
        bands: [
          { from: 500,          label: '500+',          amount: 10000 },
          { from: 400, to: 499, label: '400–499',       amount: 7500 },
          { from: 300, to: 399, label: '300–399',       amount: 5000 },
          {            to: 299, label: '299 and below', amount: 0 },
        ],
      },
    ],
  },
  {
    email: 'stara@simple.biz',
    name: 'Abella, Esterlita I. "Star"',
    effectiveFrom: HSL_MANAGER_SHEET_2026_08_30,
    components: [
      {
        kind: 'banded', key: 'completion_pct', label: 'Post-Hearing completion this week', unit: '% completion',
        bands: [
          { from: 100,            label: '100%+ Completion',         amount: 5000 },
          { from: 90, to: 99.99,  label: '90% – 99.99% Completion',  amount: 3500 },
          { from: 85, to: 89.99,  label: '85% – 89.99% Completion',  amount: 2500 },
          {           to: 84.99,  label: 'Below 85% Completion',     amount: 0 },
        ],
      },
    ],
  },
  {
    email: 'arr@simple.biz',
    name: 'Rosales, Anna Rowella "AR"',
    effectiveFrom: HSL_MANAGER_SHEET_2026_08_30,
    components: [
      {
        kind: 'banded', key: 'failovers', label: 'Executive Guest Services failovers this week', unit: 'failovers',
        bands: [
          { from: 0, to: 0, label: '0 failovers',  amount: 10000 },
          { from: 1, to: 1, label: '1 failover',   amount: 5000 },
          { from: 2,        label: '2+ failovers', amount: 0 },
        ],
      },
    ],
  },
  {
    email: 'jazminer@simple.biz',
    name: 'Roa, Sajda "Jazmine"',
    effectiveFrom: HSL_MANAGER_SHEET_2026_08_30,
    components: [
      {
        kind: 'banded', key: 'weekly_batches', label: 'Mail-Sorting batches this week', unit: 'batches',
        bands: [
          { from: 40,         label: '40–50+ Weekly Batches',      amount: 2000 },
          { from: 30, to: 39, label: '30–39 Weekly Batches',       amount: 1500 },
          {           to: 29, label: '29 or fewer Weekly Batches', amount: 0 },
        ],
      },
    ],
  },
  {
    email: 'emss@simple.biz',
    name: 'Solon, Emily "Ems"',
    effectiveFrom: HSL_MANAGER_SHEET_2026_08_30,
    components: [
      {
        kind: 'banded', key: 'case_prepared_pct', label: 'Pre-Hearing cases prepared this week', unit: '% prepared',
        bands: [
          { from: 98,            label: '98% – 100% Case Prepared',   amount: 5000 },
          { from: 95, to: 97.99, label: '95% – 97.99% Case Prepared', amount: 3500 },
          { from: 87, to: 94.99, label: '87% – 94.99% Case Prepared', amount: 2500 },
          {           to: 86.99, label: 'Below 87% Case Prepared',    amount: 0 },
        ],
      },
    ],
  },
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertPeriodStart(periodStart: string): void {
  if (!ISO_DATE.test(periodStart)) {
    throw new Error(`Managers Weekly needs an ISO period_start (YYYY-MM-DD) to pick a dated spec, got "${periodStart}"`);
  }
}

/** The manager spec that governs the payroll week starting `periodStart`: the
 *  version with the latest `effectiveFrom` on or before that Sunday (an undated
 *  version applies from the dept's creation). Undefined for an email with no
 *  spec that week — e.g. Sherwin before 2026-08-30, or an external member added
 *  to the Managers dept, who therefore scores ₱0. */
export function managerSpecFor(email: string, periodStart: string): HslManagerSpec | undefined {
  assertPeriodStart(periodStart);
  const em = email.toLowerCase();
  let best: HslManagerSpec | undefined;
  for (const spec of HSL_MANAGERS) {
    if (spec.email.toLowerCase() !== em) continue;
    const from = spec.effectiveFrom ?? '';
    if (from > periodStart) continue;
    if (!best || from > (best.effectiveFrom ?? '')) best = spec;
  }
  return best;
}

/** The Managers Weekly lineup for the week starting `periodStart` — one resolved
 *  spec per manager who has one that week, in first-listed order. */
export function managerCohortFor(periodStart: string): HslManagerSpec[] {
  assertPeriodStart(periodStart);
  const seen = new Set<string>();
  const cohort: HslManagerSpec[] = [];
  for (const spec of HSL_MANAGERS) {
    const em = spec.email.toLowerCase();
    if (seen.has(em)) continue;
    const resolved = managerSpecFor(em, periodStart);
    if (!resolved) continue;
    seen.add(em);
    cohort.push(resolved);
  }
  return cohort;
}

/** The band a week's achieved value lands in, or undefined when no band covers it. */
export function landedBand(bands: ManagerBand[], value: number): ManagerBand | undefined {
  if (!Number.isFinite(value)) return undefined;
  return bands.find(
    (b) => (b.from === undefined || value >= b.from) && (b.to === undefined || value <= b.to),
  );
}

/** The number the band picker stores for a chosen band — a value that lands back
 *  in that same band (`landedBand(bands, bandValue(b)) === b`, pinned by test).
 *  Storing a NUMBER rather than a band name keeps `kpi_data` numeric, so a real
 *  count typed in later scores through the same path. */
export function bandValue(band: ManagerBand): number {
  return band.from ?? band.to ?? 0;
}

/** Sum a manager's incentive components for the week starting `opts.periodStart`:
 *  every ticked 'check' component plus the landed band of every 'banded' one.
 *  Unknown emails for that week have no components and score ₱0.
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
  opts: { periodStart: string; includeMonthly?: boolean },
): number {
  const spec = managerSpecFor(email, opts.periodStart);
  if (!spec) return 0;
  const includeMonthly = opts.includeMonthly ?? true;
  let total = 0;
  for (const c of spec.components) {
    if (c.cadence === 'monthly' && !includeMonthly) continue;
    if (c.kind === 'banded') {
      const v = kpiData[c.key];
      if (typeof v !== 'number') continue; // unset (or a stale boolean) = not scored
      const band = landedBand(c.bands, v);
      if (band) total += band.amount;
      continue;
    }
    if (kpiData[c.key]) total += c.amount;
  }
  return total;
}
