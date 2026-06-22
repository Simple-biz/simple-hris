/**
 * Server-safe role constants. A user is "elevated" if they hold any of these active roles,
 * which lets them view/act on other employees' data (payroll, disputes, leave, etc.).
 *
 * Must match the role set used by the client-side view picker in `src/lib/rbac/views.ts`
 * (ACCOUNTING_ROLES ∪ {'admin'}). Kept here as a plain module so server code can import it
 * without pulling in a 'use client' file.
 */

export const ELEVATED_ROLES = [
  'admin',
  'accounting',
  'hr_coordinator',
] as const;

export type ElevatedRole = (typeof ELEVATED_ROLES)[number];

const ELEVATED_SET = new Set<string>(ELEVATED_ROLES);

export function isElevatedRole(role: string | null | undefined): boolean {
  return !!role && ELEVATED_SET.has(role);
}

export function hasElevatedRole(roles: readonly string[] | null | undefined): boolean {
  return !!roles && roles.some((r) => ELEVATED_SET.has(r));
}

/**
 * Roles allowed to receive RAW PAY-RATE figures (regular/OT/hourly rates) over
 * the wire — "full rate visibility". This is a STRICTER set than
 * {@link ELEVATED_ROLES} on purpose:
 *
 *  - It EXCLUDES `hr_coordinator`. HR (and Managers, who are not elevated at all)
 *    must never receive a numeric pay rate from any endpoint — rates are
 *    Accounting/CEO only. HR confirms compensation through the Payment Catalog
 *    and sees only a "ready/not set" status, never the figure.
 *  - It INCLUDES `ceo` (which is absent from ELEVATED_ROLES) so CEO surfaces keep
 *    full rate visibility alongside Accounting.
 *
 * Use this for endpoints whose response carries pay-rate numbers. Endpoints that
 * return rates to accounting AND non-rate fields to others should branch on
 * {@link hasRateVisibility} and project the rate columns away for everyone else.
 *
 * NOTE: a person who legitimately does Accounting work must hold the `accounting`
 * role; holding only `hr_coordinator` no longer grants rate visibility.
 */
export const RATE_VISIBLE_ROLES = [
  'admin',
  'accounting',
  'ceo',
] as const;

export type RateVisibleRole = (typeof RATE_VISIBLE_ROLES)[number];

const RATE_VISIBLE_SET = new Set<string>(RATE_VISIBLE_ROLES);

export function hasRateVisibility(roles: readonly string[] | null | undefined): boolean {
  return !!roles && roles.some((r) => RATE_VISIBLE_SET.has(r));
}
