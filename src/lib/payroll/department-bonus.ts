// Shared department-bonus engine.
//
// Extracted verbatim from PayrollWizard so the accountant-facing Payroll Wizard
// (Additions) and the manager-facing KPI Calculator compute *identical* bonuses
// from one source of truth. PayrollWizard imports these symbols back; the only
// change from the original is the `calculateDepartmentBonus` parameter type,
// which is now the minimal `BonusEmployee` (CalcRow is structurally assignable).

/** Minimal employee shape the bonus engine needs. */
export type BonusEmployee = { email: string; name: string };

/**
 * Special bonus id whose amount is **per-employee** rather than a flat dept-wide
 * amount. The amount comes from the latest ready/locked SSD Medical Records KPI
 * sheet (`hsl_bonus_entries.calculated_bonus`). Surfaces on the Hogan Smith Law
 * tab; only members of the SSD Medical Records team are eligible.
 */
export const KPI_BONUS_ID = 'kpi_bonus';

export const DEPARTMENTS: {
  key: string;
  name: string;
  bonuses: { id: string; label: string; amount: number }[];
}[] = [
  { key: 'accounting',       name: 'Accounting',         bonuses: [] },
  { key: 'edit',             name: 'Edit',               bonuses: [] },
  { key: 'devs',             name: 'AI/API Team',         bonuses: [] },
  { key: 'lead_gen',         name: 'Lead Gen',           bonuses: [] },
  {
    key: 'us_manager_bonus',
    name: 'US - Manager Bonus',
    bonuses: [
      { id: 'usmgr_leadership', label: 'Leadership Excellence Award', amount: 3500 },
      { id: 'usmgr_team',       label: 'Team Performance Bonus',      amount: 3000 },
    ],
  },
  { key: 'callback',         name: 'Callback',           bonuses: [] },
  { key: 'qc',               name: 'QC',                 bonuses: [] },
  { key: 'discovery',        name: 'Discovery',          bonuses: [] },
  { key: 'hr',               name: 'HR',                 bonuses: [] },
  { key: 'sales_assistant',  name: 'Sales Assistant',    bonuses: [] },
  { key: 'smart_staff',      name: 'Smart Staff',        bonuses: [] },
  {
    key: 'hogan_smith_law',
    name: 'Hogan Smith Law',
    // The KPI Bonus amount is sourced from `hsl_bonus_entries` per employee
    // (latest ready/locked SSD Medical Records week). The `amount: 0` here is
    // a sentinel; the actual value is read from `ssdKpiAmounts[email]`.
    bonuses: [
      { id: KPI_BONUS_ID, label: 'KPI Bonus', amount: 0 },
    ],
  },
  { key: 'smm',              name: 'Social Media',       bonuses: [] },
  { key: 'pm_team',          name: 'PM Team',            bonuses: [] },
  { key: 'client_va',        name: 'Client VA',          bonuses: [] },
  { key: 'site_building',    name: 'Site Building',      bonuses: [] },
];

/**
 * Lead Gen appointment-based bonus:
 *   1–9  appointments → ₱250 per appointment
 *   10+  appointments → ₱500 per appointment
 */
export function calcLeadGenBonus(appointments: number): number {
  if (appointments <= 0) return 0;
  return appointments >= 10 ? appointments * 500 : appointments * 250;
}

/**
 * Returns true when every token in `pattern` appears in the tokenized employee name.
 * Case-insensitive; ignores punctuation. Supports both "Last, First" and "First Last" formats.
 */
function nameMatchesPattern(empName: string, pattern: string): boolean {
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  const empTokens = new Set(normalize(empName));
  return normalize(pattern).every(t => empTokens.has(t));
}

/** DEVS — Site Delivery eligibles: Enriquez Harry Jr. and Lagundi Bryan */
export function isDevsDelivery(name: string): boolean {
  return nameMatchesPattern(name, 'Enriquez Harry') || nameMatchesPattern(name, 'Lagundi Bryan');
}

/** DEVS — Site Checking eligibles: Ranis Christian, Velasco Anjeo, Felices John Carl */
export function isDevsChecking(name: string): boolean {
  return (
    nameMatchesPattern(name, 'Ranis Christian') ||
    nameMatchesPattern(name, 'Velasco Anjeo') ||
    nameMatchesPattern(name, 'Felices John Carl')
  );
}

/** QC — Jerome Rosero receives a separate calculation and optional Callback bonuses */
export function isJeromeRosero(name: string): boolean {
  return nameMatchesPattern(name, 'Jerome Rosero');
}

/** HR — "Teal" is excluded from the headcount multiplier */
export function isTeal(name: string): boolean {
  return name.trim().toLowerCase().includes('teal');
}

/**
 * Departments that use formula-based bonus calculation instead of manual toggles.
 * Lead Gen is included but intentionally returns zero (department disregarded per policy).
 */
export const FORMULA_DEPT_KEYS = new Set([
  'accounting', 'edit', 'devs', 'lead_gen',
  'callback', 'qc', 'discovery', 'hr', 'sales_assistant', 'smart_staff',
]);

/** Mon–Fri collection counts; sum drives Accounting weekly tier. Keys present ⇒ sum only; else legacy `collected` total. */
export const ACCOUNTING_WEEKDAY_METRICS: { key: string; label: string }[] = [
  { key: 'collectedMon', label: 'Mon' },
  { key: 'collectedTue', label: 'Tue' },
  { key: 'collectedWed', label: 'Wed' },
  { key: 'collectedThu', label: 'Thu' },
  { key: 'collectedFri', label: 'Fri' },
];

export function accountingWeeklyCollectedTotal(em: Record<string, number>): number {
  const hasDailyBreakdown = ACCOUNTING_WEEKDAY_METRICS.some(({ key }) =>
    Object.prototype.hasOwnProperty.call(em, key),
  );
  if (hasDailyBreakdown) {
    return ACCOUNTING_WEEKDAY_METRICS.reduce((sum, { key }) => sum + (em[key] ?? 0), 0);
  }
  return em.collected ?? 0;
}

// ── Manager KPI Calculator: per-department input configuration ────────────────
//
// Drives the manager-facing calculator UI. Each entry declares which numeric
// inputs to show (per-employee and/or department-level) so the same numbers the
// accountant enters in the Payroll Wizard can be entered by the dept's manager.
// `smart_staff` and `hogan_smith_law` are intentionally absent — both already
// exist in the HSL KPI Calculator and are excluded from this feature.

export interface PerEmployeeMetricField {
  /** Key under empMetrics[email]. */
  key: string;
  label: string;
  /** Short rate hint shown under the input. */
  hint?: string;
  /** When set, only employees whose name matches show this input (name-based eligibility). */
  appliesTo?: (name: string) => boolean;
}

export interface DeptLevelMetricField {
  /** Key under deptMetrics[deptKey]. */
  key: string;
  label: string;
  hint?: string;
}

export interface DeptInputConfig {
  /** Per-employee numeric inputs. */
  employeeFields: PerEmployeeMetricField[];
  /** Department-level numeric inputs (one value shared across the dept). */
  deptFields: DeptLevelMetricField[];
  /** True when bonuses come from manual toggle awards (DEPARTMENTS[].bonuses) rather than a metric formula. */
  useToggleBonuses?: boolean;
  /** Plain-language formula summary for the manager. */
  formula: string;
}

export const DEPT_INPUT_CONFIG: Record<string, DeptInputConfig> = {
  accounting: {
    employeeFields: [],
    deptFields: ACCOUNTING_WEEKDAY_METRICS.map((m) => ({ key: m.key, label: m.label, hint: 'collections' })),
    formula:
      'Per day: ≥30 → +₱450, ≥22 → +₱300, ≥17 → +₱200. Summed Mon–Fri; everyone in the dept gets the same total.',
  },
  edit: {
    employeeFields: [{ key: 'tickets', label: 'Tickets Completed', hint: '₱50 each' }],
    deptFields: [],
    formula: '₱50 per completed ticket.',
  },
  devs: {
    employeeFields: [
      { key: 'tickets', label: 'Tickets Completed', hint: '₱50 each' },
      { key: 'siteDelivery', label: 'Site Delivery', hint: '₱50 each', appliesTo: isDevsDelivery },
      { key: 'siteChecking', label: 'Site Checking', hint: '₱250 each', appliesTo: isDevsChecking },
    ],
    deptFields: [],
    formula: '₱50 per ticket. Eligible names also earn Site Delivery (+₱50 each) or Site Checking (+₱250 each).',
  },
  lead_gen: {
    employeeFields: [{ key: 'leadGenAppts', label: 'Appointments Set', hint: '1–9 → ₱250 ea · 10+ → ₱500 ea' }],
    deptFields: [],
    formula: '1–9 appointments → ₱250 each; 10+ → ₱500 each; 0 → ₱0.',
  },
  us_manager_bonus: {
    employeeFields: [],
    deptFields: [],
    useToggleBonuses: true,
    formula: 'Toggle awards per person: Leadership Excellence ₱3,500; Team Performance ₱3,000.',
  },
  callback: {
    employeeFields: [
      { key: 'callbackAppts', label: 'Callback Appts', hint: '₱50 each' },
      { key: 'leadGenAppts', label: 'Lead Gen Appts', hint: '1–9 → ₱250 ea · 10+ → ₱500 ea' },
    ],
    deptFields: [],
    formula: '₱50 per callback appointment + the lead-gen tier applied to lead-gen appointments.',
  },
  qc: {
    employeeFields: [
      { key: 'callbackAppts', label: 'Callback Appts', hint: '₱50 each (Jerome only)', appliesTo: isJeromeRosero },
    ],
    deptFields: [{ key: 'unitsSold', label: 'Units Sold (this period)', hint: '₱150/unit if ≥6 standard members, else ₱125' }],
    formula:
      'Pool = units × (₱150 if ≥6 standard members, else ₱125), split equally. Jerome Rosero instead earns units × ₱30 + callbacks × ₱50.',
  },
  discovery: {
    employeeFields: [{ key: 'unitsSoldPriorWeek', label: 'Units Sold (prior week)', hint: '₱25 each' }],
    deptFields: [],
    formula: '₱25 per unit sold the prior week.',
  },
  hr: {
    employeeFields: [],
    deptFields: [{ key: 'newHires', label: 'New Hires (passed 4 weeks)', hint: 'pool ÷ new hires' }],
    formula: 'Pool = (billable members, excluding Teal) × ₱1,000 ÷ new hires. Everyone gets an equal share.',
  },
  sales_assistant: {
    employeeFields: [{ key: 'salesLastWeek', label: 'Sales (last week)', hint: '₱150 each' }],
    deptFields: [],
    formula: '₱150 per sale last week.',
  },
  smm: { employeeFields: [], deptFields: [], formula: 'No bonus formula defined yet — roster only.' },
  pm_team: { employeeFields: [], deptFields: [], formula: 'No bonus formula defined yet — roster only.' },
  client_va: { employeeFields: [], deptFields: [], formula: 'No bonus formula defined yet — roster only.' },
  site_building: { employeeFields: [], deptFields: [], formula: 'No bonus formula defined yet — roster only.' },
};

/** Department keys that appear in the manager KPI Calculator (excludes smart_staff + hogan_smith_law). */
export const MANAGER_BONUS_DEPT_KEYS = Object.keys(DEPT_INPUT_CONFIG);

/** Short "what this team does" blurb shown on each department's KPI card. */
export const DEPT_DESCRIPTION: Record<string, string> = {
  accounting: 'Tracks daily collections and reconciles the books, chasing the weekly collection targets.',
  edit: 'Polishes and finalizes client tickets, turning rough drafts into delivered work.',
  devs: 'Builds and ships AI/API integrations, then delivers and quality-checks live sites.',
  lead_gen: 'Books qualified appointments and keeps the sales pipeline full.',
  us_manager_bonus: 'US-based team leads recognized for leadership and overall team performance.',
  callback: 'Re-engages prospects through callbacks and converts them into booked appointments.',
  qc: 'Quality-checks finished units before they ship, protecting output standards.',
  discovery: 'Runs discovery calls and surfaces fresh sales opportunities each week.',
  hr: 'Recruits, onboards, and supports the workforce, keeping new talent flowing in.',
  sales_assistant: 'Backs up the sales team and closes assisted deals week over week.',
  smm: 'Runs the social channels and grows audience, reach, and engagement.',
  pm_team: 'Coordinates projects across teams and keeps delivery on schedule.',
  client_va: 'Dedicated virtual assistants embedded directly with client accounts.',
  site_building: 'Builds and launches client websites end to end.',
};

/**
 * Computes department-specific bonuses for all employees in a single department.
 * Returns a map of email → bonus amount (does NOT include common bonuses).
 *
 * @param deptKey        - Department key from DEPARTMENTS
 * @param employees      - employees assigned to this department
 * @param empMetrics     - Per-employee numeric metrics (tickets, collected, appts, etc.)
 * @param deptMetrics    - Department-level numeric metrics (unitsSold for QC, newHires for HR)
 */
export function calculateDepartmentBonus(
  deptKey: string,
  employees: BonusEmployee[],
  empMetrics: Record<string, Record<string, number>>,
  deptMetrics: Record<string, Record<string, number>>,
): Record<string, number> {
  const result: Record<string, number> = {};
  const em = (email: string) => empMetrics[email] ?? {};
  const dm = deptMetrics[deptKey] ?? {};

  switch (deptKey) {
    // ── Accounting (dept-level daily counts → same bonus for everyone) ──────
    case 'accounting': {
      const hasDailyBreakdown = ACCOUNTING_WEEKDAY_METRICS.some(({ key }) =>
        Object.prototype.hasOwnProperty.call(dm, key),
      );
      let sharedBonus = 0;
      if (hasDailyBreakdown) {
        for (const { key } of ACCOUNTING_WEEKDAY_METRICS) {
          const day = dm[key] ?? 0;
          if (day >= 30)      sharedBonus += 450;
          else if (day >= 22) sharedBonus += 300;
          else if (day >= 17) sharedBonus += 200;
        }
      } else {
        const collected = dm.collected ?? 0;
        if (collected >= 30)      sharedBonus = 450;
        else if (collected >= 22) sharedBonus = 300;
        else if (collected >= 17) sharedBonus = 200;
      }
      for (const emp of employees) {
        result[emp.email] = sharedBonus;
      }
      break;
    }

    // ── Edit (₱50 per completed ticket) ────────────────────────────────────
    case 'edit': {
      for (const emp of employees) {
        result[emp.email] = (em(emp.email).tickets ?? 0) * 50;
      }
      break;
    }

    // ── Devs (tickets + site delivery or site checking) ────────────────────
    case 'devs': {
      for (const emp of employees) {
        const metrics = em(emp.email);
        let bonus = (metrics.tickets ?? 0) * 50;
        if (isDevsDelivery(emp.name)) {
          bonus += (metrics.siteDelivery ?? 0) * 50;
        } else if (isDevsChecking(emp.name)) {
          bonus += (metrics.siteChecking ?? 0) * 250;
        }
        result[emp.email] = bonus;
      }
      break;
    }

    // ── Callback (₱50/callback appt + lead gen tier inside callback) ───────
    case 'callback': {
      for (const emp of employees) {
        const metrics = em(emp.email);
        const callbackBonus = (metrics.callbackAppts ?? 0) * 50;
        const leadGenBonus  = calcLeadGenBonus(metrics.leadGenAppts ?? 0);
        result[emp.email] = callbackBonus + leadGenBonus;
      }
      break;
    }

    // ── QC (pool split + Jerome Rosero exception) ──────────────────────────
    case 'qc': {
      const unitsSold = dm.unitsSold ?? 0;
      const standardMembers = employees.filter(e => !isJeromeRosero(e.name));
      const standardCount = standardMembers.length;
      const poolRate = standardCount >= 6 ? 150 : 125;
      const pool = unitsSold * poolRate;
      const perMember = standardCount > 0 ? pool / standardCount : 0;

      for (const emp of employees) {
        if (isJeromeRosero(emp.name)) {
          const callbackBonus = (em(emp.email).callbackAppts ?? 0) * 50;
          result[emp.email] = unitsSold * 30 + callbackBonus;
        } else {
          result[emp.email] = perMember;
        }
      }
      break;
    }

    // ── Discovery (₱25 per unit sold prior week) ───────────────────────────
    case 'discovery': {
      for (const emp of employees) {
        result[emp.email] = (em(emp.email).unitsSoldPriorWeek ?? 0) * 25;
      }
      break;
    }

    // ── HR (pool ÷ new hires; Teal excluded from headcount multiplier) ─────
    case 'hr': {
      const newHires = dm.newHires ?? 0;
      const billableCount = employees.filter(e => !isTeal(e.name)).length;
      const pool = billableCount * 1000;
      const individual = newHires > 0 ? pool / newHires : 0;
      for (const emp of employees) {
        result[emp.email] = individual;
      }
      break;
    }

    // ── Sales Assistant (₱150 per sale last week) ──────────────────────────
    case 'sales_assistant': {
      for (const emp of employees) {
        result[emp.email] = (em(emp.email).salesLastWeek ?? 0) * 150;
      }
      break;
    }

    // ── SmartStaff (₱250 per appointment set) ──────────────────────────────
    case 'smart_staff': {
      for (const emp of employees) {
        result[emp.email] = (em(emp.email).appointmentsSet ?? 0) * 250;
      }
      break;
    }

    // ── Lead Gen (₱500/appt when ≥ 10, else ₱250/appt, 0 when zero) ───────
    case 'lead_gen': {
      for (const emp of employees) {
        result[emp.email] = calcLeadGenBonus(em(emp.email).leadGenAppts ?? 0);
      }
      break;
    }

    default:
      break;
  }

  return result;
}
