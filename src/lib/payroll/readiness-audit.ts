/**
 * Shared "where did this change come from?" tagging for the three write paths
 * the Payroll Wizard's Readiness tab drives — Set rate, Set bank, and KPI
 * Mark-Ready/Lock. Each write accepts an optional `source` string; the APIs use
 * it to attribute the change in the Audit Log (and, for rates, the Rate History
 * note), so a fix made from the wizard reads "via Payroll Wizard" instead of
 * looking like a normal Payment Catalog edit or an employee self-update.
 *
 * Client and server both import from here so the accepted values and their
 * human labels never drift apart.
 */

/** A change made from the Payroll Wizard → Readiness tab's inline fixers. */
export const READINESS_SOURCE = 'payroll_wizard_readiness';
/** A rate set the ordinary way in the Payment Catalog's Pay Structure tab. */
export const PAYMENT_CATALOG_SOURCE = 'payment_catalog';
/** A bank/payout edit made in the People tab (accounting), not self-service. */
export const PEOPLE_TAB_SOURCE = 'people_tab';
/** A KPI submission from the manager's own KPI Calculator tab. */
export const MANAGER_KPI_SOURCE = 'manager_kpi';
/** An employee self-updating their own payout details from the dashboard. */
export const EMPLOYEE_DASHBOARD_SOURCE = 'employee_dashboard';

/** Every source string the write APIs will accept. Anything else is rejected so
 *  a typo can't poison the audit trail with an unlabeled origin. */
export const CHANGE_SOURCES = new Set<string>([
  READINESS_SOURCE,
  PAYMENT_CATALOG_SOURCE,
  PEOPLE_TAB_SOURCE,
  MANAGER_KPI_SOURCE,
  EMPLOYEE_DASHBOARD_SOURCE,
]);

/** True when `source` is a recognized origin (and thus safe to record). */
export function isChangeSource(source: unknown): source is string {
  return typeof source === 'string' && CHANGE_SOURCES.has(source);
}

/** Normalize a possibly-missing/unknown source to an accepted one, falling back
 *  to `fallback` (which each caller sets to the origin of its own surface). */
export function normalizeSource(source: unknown, fallback: string): string {
  return isChangeSource(source) ? source : fallback;
}

const SOURCE_LABELS: Record<string, string> = {
  [READINESS_SOURCE]: 'Payroll Wizard (Readiness)',
  [PAYMENT_CATALOG_SOURCE]: 'Payment Catalog',
  [PEOPLE_TAB_SOURCE]: 'People tab',
  [MANAGER_KPI_SOURCE]: 'Manager KPI tab',
  [EMPLOYEE_DASHBOARD_SOURCE]: 'Employee dashboard',
};

/** Human-readable label for a change source, for notes and the Audit Log UI.
 *  Unknown values pass through verbatim so nothing is ever hidden. */
export function sourceLabel(source: string | null | undefined): string {
  const s = (source ?? '').trim();
  if (!s) return 'Unknown';
  return SOURCE_LABELS[s] ?? s;
}
