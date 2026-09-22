// What the Payroll Wizard pays a "Managers Weekly" person for ONE week.
//
// THE BUG THIS EXISTS FOR (Kane, 2026-09-22: "Are we absolutely sure that the new
// updates for the HSL Bonuses are updating the Payroll Wizard?"). Every other HSL
// branch pays its stored `hsl_bonus_entries.calculated_bonus` verbatim. The one
// `perEmployee` branch — `hsl_managers` — did not: the wizard threw the stored
// figure away and RECOMPUTED with `calcManagerBonus(email, kpi_data, …)`.
//
// It recomputes for a real reason. A manager's spec can carry `monthly`
// components (Gyd's PHP 25,000), the card always scores them, and only the final
// payroll week of the month may pay them — so the stored value is always the
// month-inclusive one and the wizard has to withhold the monthly part in weeks
// 1-3. But `calcManagerBonus` walks `spec.components` and nothing else, so the
// recompute also silently discarded anything the stored figure carried that the
// spec does not define — as of 2026-09-22 that is a **Bonus Library bonus
// assigned to `hsl:hsl_managers`**, whose inputs live under the `catalog:`
// namespace (`catalog-bonus.ts`). Scored on the card, stored, dropped at pay time.
//
// THE FIX IS A NARROWING, not a second scoring engine. Start from the stored
// figure — the same source of truth every other branch uses — and subtract only
// the thing the recompute exists to withhold:
//
//     amount = stored - (monthly-inclusive spec total - this-week spec total)
//
// In the final week the two spec totals are equal and the amount IS the stored
// figure. In weeks 1-3 exactly the monthly components come off, and everything
// else the card scored — catalog bonuses included, and anything added later —
// survives without this module needing to know what it was.
//
// CLIENT-SAFE: pure functions only.

import { calcManagerBonus, type KpiData } from './schema';

export interface ManagerWeekAmount {
  /** Pesos to pay this week. Never negative. */
  amount: number;
  /** Monthly-only spec pesos withheld this week (0 in the final week). */
  monthlyWithheld: number;
  /**
   * The stored figure was SMALLER than the monthly components it is supposed to
   * contain, so it cannot have been written by `scoreEntry`. The amount is
   * clamped to 0 and the caller must say so out loud — a negative KPI bonus
   * would quietly cut the person's pay.
   */
  inconsistent: boolean;
}

/**
 * @param storedBonus  `hsl_bonus_entries.calculated_bonus` as saved by the card.
 * @param isFinalWeek  Whether this payroll week is the month's final one
 *                     (`isFinalPayrollWeekOfMonth`) — monthly components pay only then.
 */
export function managerWeekAmount(params: {
  storedBonus: number | null | undefined;
  email: string;
  kpiData: KpiData;
  periodStart: string;
  isFinalWeek: boolean;
}): ManagerWeekAmount {
  const raw = Number(params.storedBonus ?? 0);
  const stored = Number.isFinite(raw) ? raw : 0;

  const inclusive = calcManagerBonus(params.email, params.kpiData, {
    periodStart: params.periodStart,
    includeMonthly: true,
  });
  const thisWeek = params.isFinalWeek
    ? inclusive
    : calcManagerBonus(params.email, params.kpiData, {
        periodStart: params.periodStart,
        includeMonthly: false,
      });

  // Non-negative by construction: dropping components can only lower the total.
  const monthlyWithheld = Math.max(0, inclusive - thisWeek);
  const net = stored - monthlyWithheld;

  return {
    amount: Math.max(0, Math.round(net)),
    monthlyWithheld,
    inconsistent: net < 0,
  };
}
