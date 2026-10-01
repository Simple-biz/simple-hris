/**
 * The Dancing Queen preview: what the Accounting Team's collections bonus WOULD come to for a
 * scoreboard week. DISPLAY ONLY. Nothing here writes pay.
 * Governing doc: docs/features/accounting-scoreboard.md § The bonus preview.
 *
 * The bonus lives in the Payment Catalog (`bonus_catalog_bonuses`, formula kind, assigned to the
 * `accounting` department) with day variables Monday … Friday. The accountant types the five
 * collections day totals into the KPI calculator every week, and those values are POINTS:
 * `bonus_catalog_applied` matched the points totals on all 8 weeks 2026-08-02 → 09-20. The code
 * calls them "collection counts" (department-bonus.ts:120).
 *
 * Which unit SHOULD pay is an open money ruling (audit Open item 315), so the preview evaluates
 * the live catalog formula twice: on points (what is paid today) and on accounts. It never picks one.
 *
 * Pure apart from the shared formula engine, which is itself pure.
 */

import { evaluateFormula, validateFormula } from '@/lib/bonus-catalog/formula';
import type { PointsAndAccounts } from './scoring';

/** The catalog's variable names for the five day totals, in Mon–Fri order. */
export const DAY_VARIABLES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] as const;

export interface FormulaBonus {
  id: string;
  name: string;
  formula: string;
  version: number | null;
  currency: string | null;
}

export type PreviewVerdict =
  | { ok: true; bonus: FormulaBonus }
  | { ok: false; reason: string };

/**
 * Picks the ONE formula bonus the preview can evaluate: department-assigned to `accounting`,
 * valid, and reading no variable but the five day names. A formula that reads anything else
 * would silently treat it as 0 (formula.ts:308-311), so it is refused rather than half-run.
 * Zero or several candidates is a refusal too, because the preview must not guess which one pays.
 */
export function pickPreviewBonus(candidates: readonly FormulaBonus[]): PreviewVerdict {
  const usable: FormulaBonus[] = [];
  const allowed = new Set<string>(DAY_VARIABLES);
  for (const b of candidates) {
    const v = validateFormula(b.formula ?? '');
    if (!v.ok) continue;
    if (v.variables.length === 0 || !v.variables.every((name) => allowed.has(name))) continue;
    usable.push(b);
  }
  if (usable.length === 0) {
    return {
      ok: false,
      reason: 'No Payment Catalog formula bonus is assigned to Accounting with Monday–Friday variables.',
    };
  }
  if (usable.length > 1) {
    return {
      ok: false,
      reason: `${usable.length} Accounting formula bonuses read Monday–Friday (${usable
        .map((b) => b.name)
        .join(', ')}). The preview will not guess which one pays.`,
    };
  }
  return { ok: true, bonus: usable[0] };
}

/** Evaluate the bonus formula on five day values (Mon–Fri order). */
export function evaluateWeek(formula: string, mondayToFriday: readonly number[]): number {
  if (mondayToFriday.length !== DAY_VARIABLES.length) {
    throw new Error(`Expected 5 day values, got ${mondayToFriday.length}`);
  }
  const vars: Record<string, number> = {};
  DAY_VARIABLES.forEach((name, i) => {
    vars[name] = mondayToFriday[i];
  });
  return evaluateFormula(formula, vars);
}

export interface BonusPreview {
  byPoints: number;
  byAccounts: number;
}

/** The week under both readings. `days` are the team's Mon–Fri totals. */
export function previewBoth(formula: string, days: readonly PointsAndAccounts[]): BonusPreview {
  return {
    byPoints: evaluateWeek(formula, days.map((d) => d.points)),
    byAccounts: evaluateWeek(formula, days.map((d) => d.accounts)),
  };
}
