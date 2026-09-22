// Bonus Library bonuses on an HSL SUB-TEAM. Kane, 2026-09-22: "Hogan Smith Law
// under Payment Catalog - Assignments - HSL should have all its subdepartments
// so we can assign their bonuses in here".
//
// WHY THIS SHAPE, and not the one first proposed. HSL bonuses have always been
// code rules in `schema.ts`, scored on the HSL card and paid by the wizard from
// `hsl_bonus_entries.calculated_bonus`. The catalog is a different system: the
// general KPI calculator draws it, and the wizard pays it from
// `bonus_catalog_applied` filtered by WIZARD_PAYABLE_KPI_DEPT_KEYS — a set the
// HSL family is deliberately absent from (bonus-catalog.md §3.1: "a key in both
// sets is paid twice").
//
// So a catalog bonus assigned to `hsl:<sub>` is treated as an EXTRA RULE on that
// sub-team's card: its inputs live in `kpi_data` under a namespaced key and its
// amount folds into `calculated_bonus`. The money then rides the existing,
// proven HSL path. No `bonus_catalog_applied` row is written for HSL, no second
// wizard loader exists, and **no `hsl:` key ever enters the payable set** — the
// double-pay guard is untouched rather than carefully worked around.
//
// The visible consequence, and it is deliberate: the bonus shows inside the
// person's HSL KPI figure rather than as its own row in catalog reporting,
// exactly as every other HSL bonus already does.
//
// CLIENT-SAFE: pure functions only.

import type { BonusAssignment, BonusDef } from '@/lib/bonus-catalog/types';
import { evaluateFormula, validateFormula } from '@/lib/bonus-catalog/formula';
import { isFinalPayrollWeekOfMonth } from '@/lib/payroll/bonus-cadence';
import type { KpiData } from './schema';

/**
 * Namespace for every catalog-sourced key inside `kpi_data`.
 *
 * `kpi_data` is otherwise addressed by SCHEMA rule keys (`signed_rep_docs`,
 * `five_star_reviews`, …). A collision would make one bonus read another's
 * input, so catalog keys carry a prefix no rule key may use —
 * `catalog-bonus.test.ts` asserts that no `HSL_DEPTS` rule key starts with it.
 */
export const HSL_CATALOG_KPI_PREFIX = 'catalog:';

/** The `kpi_data` key holding whether this catalog bonus is ticked for a person. */
export function catalogOnKey(bonusId: string): string {
  return `${HSL_CATALOG_KPI_PREFIX}${bonusId}`;
}

/** The `kpi_data` key holding one formula variable's value for a person. */
export function catalogVarKey(bonusId: string, varName: string): string {
  return `${HSL_CATALOG_KPI_PREFIX}${bonusId}:${varName}`;
}

/** Variable names a formula references (empty for flat / invalid formulas). */
export function catalogBonusVariables(bonus: BonusDef): string[] {
  if (bonus.kind !== 'formula') return [];
  const check = validateFormula(bonus.formula ?? '');
  return check.ok ? check.variables : [];
}

/**
 * A catalog bonus is only scoreable on an HSL card when it pays in PESOS.
 *
 * The HSL calculator has NO FX rates — it has never needed them, because every
 * schema rule is peso-denominated. Rather than thread a rate through the whole
 * card (and inherit the "rate at save time is the rate that sticks" caveat the
 * general calculator carries), a USD/COP bonus assigned to a sub-team is
 * surfaced as UNSCOREABLE and contributes ₱0. Silently converting at an
 * unstated rate, or silently paying the number as if it were pesos (a $50 bonus
 * paying ₱50), are both worse than saying so.
 */
export function isScoreableOnHsl(bonus: BonusDef): boolean {
  return (bonus.currency ?? 'PHP') === 'PHP';
}

export interface HslCatalogBonus {
  bonus: BonusDef;
  /** False when the bonus cannot be scored here (non-PHP) — shown, never paid. */
  scoreable: boolean;
  /** True when it reached this person through a per-employee assignment. */
  individual: boolean;
}

/**
 * The catalog bonuses that apply to one HSL sub-team, for one person.
 *
 * Department-scoped assignments whose `departmentKey` is exactly this sub-team's
 * `hsl:<subKey>` reach everyone on the card, minus anyone the accountant
 * excluded. Employee-scoped ones reach only their own person. A bonus assigned
 * to the BARE family (`hogan_smith_law` / `HSL`) is deliberately NOT included:
 * there is no parent card to score it on, so it would be a dead assignment —
 * the Assignments tab refuses that target for the same reason.
 *
 * `monthly` bonuses appear only in the final payroll week of their month, the
 * same gate `calcBonus` applies to a monthly flat rule.
 */
export function hslCatalogBonusesFor(params: {
  subLabel: string; // `hsl:<subKey>`
  employeeEmail: string;
  assignments: readonly BonusAssignment[];
  bonuses: readonly BonusDef[];
  periodStart?: string;
  /** Extra addresses this person answers to (work + personal), lower-cased. */
  aliases?: readonly string[];
}): HslCatalogBonus[] {
  const want = params.subLabel.trim().toLowerCase();
  if (!want.startsWith('hsl:')) return [];
  const byId = new Map(params.bonuses.map((b) => [b.id, b]));
  const email = params.employeeEmail.trim().toLowerCase();
  const mine = new Set<string>([email, ...(params.aliases ?? []).map((a) => a.trim().toLowerCase())]);
  const monthlyOk = params.periodStart ? isFinalPayrollWeekOfMonth(params.periodStart) : true;

  const out: HslCatalogBonus[] = [];
  const seen = new Set<string>();
  const add = (bonus: BonusDef, individual: boolean) => {
    if (seen.has(bonus.id)) return;
    if (bonus.cadence === 'monthly' && !monthlyOk) return;
    seen.add(bonus.id);
    out.push({ bonus, scoreable: isScoreableOnHsl(bonus), individual });
  };

  for (const a of params.assignments) {
    if ((a.departmentKey ?? '').trim().toLowerCase() !== want) continue;
    const bonus = byId.get(a.bonusId);
    if (!bonus) continue;
    if (a.scope === 'employee') {
      if (mine.has((a.employeeEmail ?? '').trim().toLowerCase())) add(bonus, true);
      continue;
    }
    if (a.scope !== 'department') continue;
    const excluded = (a.excludedEmails ?? []).some((e) => mine.has(e.trim().toLowerCase()));
    if (excluded) continue;
    add(bonus, false);
  }
  return out;
}

/** One catalog bonus's peso amount for a person, from their `kpi_data`. */
export function calcHslCatalogBonus(kpiData: KpiData, bonus: BonusDef): number {
  if (!isScoreableOnHsl(bonus)) return 0;
  if (!kpiData[catalogOnKey(bonus.id)]) return 0;
  if (bonus.kind === 'flat') {
    return Number.isFinite(bonus.amount) ? (bonus.amount as number) : 0;
  }
  const check = validateFormula(bonus.formula ?? '');
  if (!check.ok) return 0;
  const nums: Record<string, number> = {};
  for (const v of check.variables) nums[v] = Number(kpiData[catalogVarKey(bonus.id, v)] ?? 0) || 0;
  try {
    const n = evaluateFormula(bonus.formula ?? '', nums);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Total catalog-sourced pesos for a person, to ADD to `calcBonus`'s result.
 *
 * Deliberately OUTSIDE the department's `monthlyMax`. That cap governs the KPI
 * rules the HSL programme defines; an accountant-assigned bonus is a separate
 * award, and folding it under the cap would silently shrink it (or shrink the
 * KPI it was added to). Same reasoning as `exemptFromMonthlyMax` on the
 * Pre-/Post-Hearing monthly rule.
 */
export function calcHslCatalogTotal(kpiData: KpiData, bonuses: readonly HslCatalogBonus[]): number {
  let total = 0;
  for (const { bonus } of bonuses) total += calcHslCatalogBonus(kpiData, bonus);
  return total;
}

/**
 * Strip every catalog key from a `kpi_data` blob — used when an assignment is
 * removed, so a stale input can never keep paying. Returns the same object when
 * there is nothing to strip, so callers can skip a state update.
 */
export function withoutCatalogKeys(kpiData: KpiData, keepBonusIds: readonly string[]): KpiData {
  const keep = new Set(keepBonusIds);
  const drop = Object.keys(kpiData).filter((k) => {
    if (!k.startsWith(HSL_CATALOG_KPI_PREFIX)) return false;
    const rest = k.slice(HSL_CATALOG_KPI_PREFIX.length);
    const id = rest.includes(':') ? rest.slice(0, rest.indexOf(':')) : rest;
    return !keep.has(id);
  });
  if (drop.length === 0) return kpiData;
  const next: KpiData = { ...kpiData };
  for (const k of drop) delete next[k];
  return next;
}
