// A DATA HSL sub-team as a scoreable branch. Kane, 2026-09-22, after checking
// Payroll Notes -> KPI Submissions: "Make sure that sub departments appear
// there as well".
//
// THE ROOT CAUSE, and it is bigger than the missing list row. The HSL
// calculator's branch list is `HSL_DEPT_KEYS.filter(...)` — the 14 CODE teams.
// A sub-team created from Payment Catalog -> Departments -> Edit
// (`hsl:healthcare_specialist`) therefore had NO CARD: nothing to score on, no
// `hsl_bonus_period_status` row, and so nothing for Payroll Readiness to list.
// It also meant the catalog-bonus work shipped earlier the same day
// (`catalog-bonus.ts`) reached the code teams only — not the team Carla had
// actually just made.
//
// A data branch is a `DeptConfig` with **no rules**: the HSL programme defines
// no KPI for it, so `calcBonus` contributes 0 and everything it pays comes from
// Bonus Library assignments. That is exactly the Simple Texting shape — a real
// team people sit in, priced and transferable, with no calculator rules of its
// own — except that it now has a card on which an accountant-assigned bonus can
// be scored.
//
// CLIENT-SAFE: pure functions only.

import type { BonusAssignment, BonusDef } from '@/lib/bonus-catalog/types';
import type { DepartmentSubUnit } from '@/lib/departments/registry';
import { HSL_DEPTS, HSL_DEPT_KEYS, type DeptConfig, type HslDeptKey } from './schema';
import { hslCatalogBonusesFor } from './catalog-bonus';

/** Neutral chrome for a data branch — the code teams each carry a hand-picked
 *  colour, and a new one has none to inherit. */
const DATA_BRANCH_CHROME = {
  color: '#64748b',
  headerBg: 'bg-slate-950/40',
  badgeCls: 'bg-slate-900/60 text-slate-300',
} as const;

/**
 * A stored sub-department rendered as a branch config.
 *
 * `key` is cast to `HslDeptKey` deliberately: every consumer keys state,
 * period-status rows and entries by that string, and a data branch's key is
 * just as real an address as a code one — `hsl_bonus_period_status.department`
 * and `hsl_bonus_entries.department` are plain text columns. The cast is the
 * seam; `isDataBranchKey` is how callers tell the two apart when it matters
 * (`HSL_DEPTS[key]` is undefined for a data branch — never index it blind).
 */
export function dataBranchConfig(sub: DepartmentSubUnit): DeptConfig {
  return {
    key: sub.key as HslDeptKey,
    name: sub.name,
    cadence: 'weekly',
    ...DATA_BRANCH_CHROME,
    rules: [],
  };
}

/** Is this branch key a DATA sub-team rather than one of the 14 code teams? */
export function isDataBranchKey(key: string): boolean {
  return !(HSL_DEPT_KEYS as readonly string[]).includes(key);
}

/**
 * Every branch config for HSL: the code teams, then the data teams.
 *
 * A data key that collides with a code key is dropped — `validateBuiltinSubsInput`
 * already refuses to store one, and silently shadowing `HSL_DEPTS` here would
 * redirect a real team's rules to an empty config.
 */
export function hslBranchConfigs(subs: readonly DepartmentSubUnit[]): Record<string, DeptConfig> {
  const out: Record<string, DeptConfig> = { ...HSL_DEPTS };
  for (const sub of subs) {
    if (!sub?.key || out[sub.key]) continue;
    out[sub.key] = dataBranchConfig(sub);
  }
  return out;
}

/** Ordered branch keys: code teams first (declaration order), then data. */
export function hslBranchKeys(subs: readonly DepartmentSubUnit[]): string[] {
  const seen = new Set<string>(HSL_DEPT_KEYS);
  const out: string[] = [...HSL_DEPT_KEYS];
  for (const sub of subs) {
    if (!sub?.key || seen.has(sub.key)) continue;
    seen.add(sub.key);
    out.push(sub.key);
  }
  return out;
}

/**
 * Does a data branch have anything for its manager to submit this week?
 *
 * It has no rules, so the ONLY thing it can pay is a Bonus Library bonus
 * assigned to its `hsl:<key>`. With none, there is nothing to score and it must
 * read `no_bonus` ("Ready by definition") rather than hold Payroll Readiness's
 * 25%-weight KPI dimension at `draft` forever — the same trap
 * `HSL_PLACEMENT_ONLY_SUB_KEYS` exists to avoid, and the same auto-Ready rule a
 * custom department with nothing assigned already gets.
 */
export function dataBranchHasWork(params: {
  subKey: string;
  assignments: readonly BonusAssignment[];
  bonuses: readonly BonusDef[];
  periodStart?: string;
}): boolean {
  return (
    hslCatalogBonusesFor({
      subLabel: `hsl:${params.subKey}`,
      // Department-scoped assignments reach everyone, so any employee address
      // answers "does this branch have a bonus this week"; a per-employee
      // assignment is caught by the same call when that person is asked.
      employeeEmail: '*',
      assignments: params.assignments,
      bonuses: params.bonuses,
      periodStart: params.periodStart,
    }).length > 0 ||
    params.assignments.some(
      (a) =>
        a.scope === 'employee' &&
        (a.departmentKey ?? '').trim().toLowerCase() === `hsl:${params.subKey}`.toLowerCase(),
    )
  );
}
