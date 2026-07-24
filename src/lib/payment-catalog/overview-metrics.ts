// Payment Catalog -- Overview metrics.
//
// Pure derivations that turn the catalog's already-loaded client state
// (pay structures, bonuses, assignments, system bonuses) into the ranked
// leaderboards + summary figures the Overview "Live Standings" board rotates
// through.
//
// Everything here is synchronous and side-effect free so the Overview tab can
// recompute on every Realtime change without an extra fetch. Cross-currency
// RANKING is done on a PHP-equivalent (via phpPerUnit) while values are shown in
// their NATIVE currency by the UI -- the org pays a mix of PHP / USD / COP.
//
// Honesty rules baked in here (the dashboard never fakes data):
//   - The department board only counts departments that actually have a
//     department-scope base rate; the rest surface as `deptsWithoutBase`.
//   - Formula bonuses have no fixed amount, so they are counted, not valued.
//   - Non-PHP figures keep their native value; the PHP-equivalent is exposed
//     only so the UI can render a faint "~PHP" subscript for ranking honesty.

import { DEPARTMENTS } from '@/lib/payroll/department-bonus';
import { phpPerUnit, type FxRates } from '@/lib/fx/currency-fx';
import type { PayStructure, PayCurrency } from '@/lib/payment-catalog/pay-structure';
import type { BonusDef, BonusAssignment, BonusKind } from '@/lib/bonus-catalog/types';
import {
  SYSTEM_BONUS_DEFAULTS,
  type SystemBonus,
  type SystemBonusCode,
} from '@/lib/payment-catalog/system-bonus';

const DEPT_NAME = new Map(DEPARTMENTS.map((d) => [d.key, d.name]));

/** Departments deliberately omitted from the Overview board. Empty since the
 *  US Team / US Manager Bonus department was retired (2026-07-07) -- it was the
 *  only excluded dept. Kept as a hook so a future USD/COP-track dept can be
 *  omitted from the standings again without re-plumbing the filters below. */
export const EXCLUDED_DEPT_KEYS = new Set<string>([]);

/** The departments the Overview actually counts/displays (DEPARTMENTS minus the
 *  excluded ones). Use this for coverage totals and the dept dot-grid. */
export const OVERVIEW_DEPARTMENTS = DEPARTMENTS.filter((d) => !EXCLUDED_DEPT_KEYS.has(d.key));

export interface OverviewInput {
  payStructures: PayStructure[];
  bonuses: BonusDef[];
  assignments: BonusAssignment[];
  systemBonuses: SystemBonus[];
  roster: { email: string; name: string; department: string }[];
  fx: FxRates;
}

/** One department's base rate, for the department leaderboard. */
export interface DeptPayRow {
  key: string;
  name: string;
  regularNative: number;
  currency: PayCurrency;
  /** PHP-equivalent -- used only for ranking. */
  regularPhp: number;
  otNative: number | null;
  /** Count of individual (employee-scope) overrides inside this department. */
  peopleCount: number;
}

/** One person's individual rate, for the people leaderboard. */
export interface PersonPayRow {
  email: string;
  name: string;
  deptKey: string;
  deptName: string;
  regularNative: number;
  currency: PayCurrency;
  regularPhp: number;
  otNative: number | null;
}

/** One flat bonus, ranked by value. */
export interface BonusValueRow {
  id: string;
  name: string;
  kind: BonusKind;
  amountNative: number;
  currency: PayCurrency;
  amountPhp: number;
  starred: boolean;
}

/** One bonus's assignment reach, split by scope. */
export interface BonusReachRow {
  id: string;
  name: string;
  deptCount: number;
  peopleCount: number;
  total: number;
  excludedCount: number;
  sharedTeam: boolean;
}

export interface CurrencyMixRow {
  currency: PayCurrency;
  count: number;
  /** Share of all pay structures, 0..1. */
  share: number;
}

export interface SystemBonusRow {
  code: SystemBonusCode;
  label: string;
  amountNative: number;
  currency: PayCurrency;
  enabled: boolean;
  /** The allowlisted department keys (empty => applies to all). */
  deptKeys: string[];
  deptCount: number;
  appliesToAll: boolean;
}

export interface OtSummary {
  /** Average OT-to-regular multiplier across rows that set an explicit OT rate. */
  avgMultiplier: number | null;
  /** The single highest OT rate anywhere. */
  highest: { rateNative: number; currency: PayCurrency; ratePhp: number; label: string } | null;
}

export interface CatalogCoverage {
  deptsWithBase: number;
  deptsTotal: number;
  deptsWithoutBase: number;
  peopleWithRate: number;
  activeBonuses: number;
  totalAssignments: number;
  formulaCount: number;
  starredBonuses: number;
}

export interface CatalogOverview {
  topDepartments: DeptPayRow[];
  topPeople: PersonPayRow[];
  topBonuses: BonusValueRow[];
  bonusReach: BonusReachRow[];
  currencyMix: CurrencyMixRow[];
  systemBonuses: SystemBonusRow[];
  ot: OtSummary;
  coverage: CatalogCoverage;
  /** True when there is essentially nothing to show yet. */
  isEmpty: boolean;
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
// Unknown keys are custom (Department-tab) departments whose slug derives from
// the display name -- humanize it back ("medical_billing" -> "Medical Billing").
const deptName = (key: string) =>
  DEPT_NAME.get(key) ?? key.replace(/_+/g, ' ').replace(/(^|\s)[a-z]/g, (c) => c.toUpperCase());

function nameForEmail(
  email: string,
  fallbackName: string | undefined,
  roster: OverviewInput['roster'],
): string {
  if (fallbackName && fallbackName.trim()) return fallbackName.trim();
  const hit = roster.find((r) => norm(r.email) === norm(email));
  if (hit?.name) return hit.name;
  const at = email.indexOf('@');
  return at > 0 ? email.slice(0, at) : email;
}

/**
 * Compute every figure the Overview dashboard needs.
 * @param topN how many rows each leaderboard keeps (default 10).
 */
export function computeCatalogOverview(input: OverviewInput, topN = 10): CatalogOverview {
  const { bonuses, systemBonuses, roster, fx } = input;
  // Drop excluded departments (e.g. US managers) from every rate / assignment
  // derivation so the standings reflect only the included org.
  const payStructures = input.payStructures.filter((s) => !EXCLUDED_DEPT_KEYS.has(s.departmentKey));
  const assignments = input.assignments.filter((a) => !EXCLUDED_DEPT_KEYS.has(a.departmentKey));
  const php = (rate: number, c: PayCurrency) => rate * phpPerUnit(c, fx);

  const deptStructures = payStructures.filter((s) => s.scope === 'department');
  const personStructures = payStructures.filter((s) => s.scope === 'employee');

  const individualsByDept = new Map<string, PayStructure[]>();
  for (const s of personStructures) {
    const arr = individualsByDept.get(s.departmentKey) ?? [];
    arr.push(s);
    individualsByDept.set(s.departmentKey, arr);
  }

  // ---- Department leaderboard (department-scope base rates only) ----------
  const topDepartments: DeptPayRow[] = deptStructures
    .filter((s) => Number.isFinite(s.regularRate))
    .map((s) => ({
      key: s.departmentKey,
      name: deptName(s.departmentKey),
      regularNative: s.regularRate,
      currency: s.currency,
      regularPhp: php(s.regularRate, s.currency),
      otNative: s.otRate != null && Number.isFinite(s.otRate) ? s.otRate : null,
      peopleCount: individualsByDept.get(s.departmentKey)?.length ?? 0,
    }))
    .sort((a, b) => b.regularPhp - a.regularPhp)
    .slice(0, topN);

  // ---- People leaderboard -------------------------------------------------
  const topPeople: PersonPayRow[] = personStructures
    .filter((s) => s.employeeEmail && Number.isFinite(s.regularRate))
    .map((s) => ({
      email: s.employeeEmail as string,
      name: nameForEmail(s.employeeEmail as string, s.employeeName, roster),
      deptKey: s.departmentKey,
      deptName: deptName(s.departmentKey),
      regularNative: s.regularRate,
      currency: s.currency,
      regularPhp: php(s.regularRate, s.currency),
      otNative: s.otRate != null && Number.isFinite(s.otRate) ? s.otRate : null,
    }))
    .sort((a, b) => b.regularPhp - a.regularPhp)
    .slice(0, topN);

  // ---- Most valuable bonuses (flat only) ----------------------------------
  const topBonuses: BonusValueRow[] = bonuses
    .filter((b) => b.kind === 'flat' && Number.isFinite(b.amount))
    .map((b) => {
      const currency: PayCurrency = b.currency ?? 'PHP';
      const amount = b.amount as number;
      return {
        id: b.id,
        name: b.name,
        kind: b.kind,
        amountNative: amount,
        currency,
        amountPhp: php(amount, currency),
        starred: !!b.starred,
      };
    })
    .sort((a, b) => b.amountPhp - a.amountPhp)
    .slice(0, topN);

  // ---- Bonus reach (assignment counts split by scope) ---------------------
  const reachByBonus = new Map<
    string,
    { dept: number; people: number; excluded: number; shared: boolean }
  >();
  for (const a of assignments) {
    const cur = reachByBonus.get(a.bonusId) ?? { dept: 0, people: 0, excluded: 0, shared: false };
    if (a.scope === 'department') {
      cur.dept += 1;
      cur.excluded += a.excludedEmails?.length ?? 0;
      if (a.sharedTeam) cur.shared = true;
    } else {
      cur.people += 1;
    }
    reachByBonus.set(a.bonusId, cur);
  }
  const bonusNameById = new Map(bonuses.map((b) => [b.id, b.name]));
  const bonusReach: BonusReachRow[] = [...reachByBonus.entries()]
    .map(([id, r]) => ({
      id,
      name: bonusNameById.get(id) ?? 'Unknown bonus',
      deptCount: r.dept,
      peopleCount: r.people,
      total: r.dept + r.people,
      excludedCount: r.excluded,
      sharedTeam: r.shared,
    }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  // ---- Currency mix -------------------------------------------------------
  const mixCounts = new Map<PayCurrency, number>();
  for (const s of payStructures) mixCounts.set(s.currency, (mixCounts.get(s.currency) ?? 0) + 1);
  const totalStructures = payStructures.length;
  const currencyMix: CurrencyMixRow[] = (['PHP', 'USD', 'COP'] as PayCurrency[])
    .map((c) => ({
      currency: c,
      count: mixCounts.get(c) ?? 0,
      share: totalStructures > 0 ? (mixCounts.get(c) ?? 0) / totalStructures : 0,
    }))
    .filter((row) => row.count > 0);

  // ---- System bonuses (always surface PAB + Tech, falling back to defaults)
  const systemBonusRows: SystemBonusRow[] = (['pab', 'tech'] as SystemBonusCode[]).map((code) => {
    const row = systemBonuses.find((b) => b.code === code);
    const def = SYSTEM_BONUS_DEFAULTS[code];
    const rawDeptKeys = row?.departmentKeys ?? [];
    const deptKeys = rawDeptKeys.filter((k) => !EXCLUDED_DEPT_KEYS.has(k));
    // A missing/non-finite stored amount falls back to the default, which is PHP
    // by definition -- force the currency to PHP too so the figure isn't mislabeled.
    const useDefaultAmount = !Number.isFinite(row?.amount);
    return {
      code,
      label: row?.label ?? def.label,
      amountNative: useDefaultAmount ? def.amount : (row!.amount as number),
      currency: useDefaultAmount ? 'PHP' : (row?.currency ?? 'PHP'),
      enabled: row ? row.enabled !== false : true,
      deptKeys,
      deptCount: deptKeys.length,
      // Empty raw allowlist = the engine's fail-open "applies to all".
      appliesToAll: rawDeptKeys.length === 0,
    };
  });

  // ---- OT premium ---------------------------------------------------------
  const otPairs = payStructures.filter(
    (s) => s.otRate != null && Number.isFinite(s.otRate) && s.regularRate > 0,
  );
  const avgMultiplier =
    otPairs.length > 0
      ? otPairs.reduce((sum, s) => sum + (s.otRate as number) / s.regularRate, 0) / otPairs.length
      : null;
  let highestOt: OtSummary['highest'] = null;
  for (const s of payStructures) {
    if (s.otRate == null || !Number.isFinite(s.otRate)) continue;
    const p = php(s.otRate, s.currency);
    if (!highestOt || p > highestOt.ratePhp) {
      const label =
        s.scope === 'employee'
          ? nameForEmail(s.employeeEmail ?? '', s.employeeName, roster)
          : `${deptName(s.departmentKey)} (dept)`;
      highestOt = { rateNative: s.otRate, currency: s.currency, ratePhp: p, label };
    }
  }

  // ---- Coverage -----------------------------------------------------------
  const deptsWithBase = new Set(deptStructures.map((s) => s.departmentKey)).size;
  const coverage: CatalogCoverage = {
    deptsWithBase,
    deptsTotal: OVERVIEW_DEPARTMENTS.length,
    deptsWithoutBase: Math.max(0, OVERVIEW_DEPARTMENTS.length - deptsWithBase),
    peopleWithRate: personStructures.length,
    activeBonuses: bonuses.length,
    totalAssignments: assignments.length,
    formulaCount: bonuses.filter((b) => b.kind === 'formula').length,
    starredBonuses: bonuses.filter((b) => b.starred).length,
  };

  const isEmpty =
    payStructures.length === 0 && bonuses.length === 0 && assignments.length === 0;

  return {
    topDepartments,
    topPeople,
    topBonuses,
    bonusReach,
    currencyMix,
    systemBonuses: systemBonusRows,
    ot: { avgMultiplier, highest: highestOt },
    coverage,
    isEmpty,
  };
}
