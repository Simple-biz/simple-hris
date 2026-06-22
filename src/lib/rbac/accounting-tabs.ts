'use client';

import type { FeaturePermissionsMap } from '@/lib/rbac/feature-permissions';

export const ACCOUNTING_TAB_IDS = [
  'overview',
  'people',
  'payroll-wizard',
  'bonus-catalog',
  'payment-dispatch',
  'disputes',
  'mesa',
  'announcements',
  'notifications',
  's-wall',
  'settings',
] as const;

export type AccountingTabId = (typeof ACCOUNTING_TAB_IDS)[number];

/** UI tab id -> feature key stored in `employee_feature_permissions`. */
const TAB_TO_FEATURE: Record<AccountingTabId, string> = {
  'overview': 'overview',
  'people': 'people',
  'payroll-wizard': 'payroll_wizard',
  'bonus-catalog': 'bonus_catalog',
  'payment-dispatch': 'payment_dispatch',
  'disputes': 'disputes',
  'mesa': 'mesa',
  'announcements': 'announcements',
  'notifications': 'notifications',
  's-wall': 's_wall',
  'settings': 'settings',
};

/**
 * Roles that bypass the per-tab overlay and always see + edit every tab.
 * Admins always see everything so locking yourself out is hard.
 */
const BYPASS_PERMS_ROLES = new Set(['admin']);

/** Always-visible tabs (read-only landing) so a dashboard is never blank. */
const ALWAYS_VISIBLE_TABS = new Set<AccountingTabId>(['overview']);

/**
 * Role baseline. The accounting dashboard no longer restricts tabs by role --
 * what an admin grants in the per-tab permission grid is the sole gate (see
 * {@link allowedAccountingTabsForUser}). This returns the full catalog and is
 * kept only so older callers don't break.
 */
export function allowedAccountingTabsForRoles(_roles: readonly string[]): AccountingTabId[] {
  return [...ACCOUNTING_TAB_IDS];
}

/**
 * Visible accounting tabs after the per-user feature-permission overlay.
 *
 * Model: HIDDEN UNTIL GRANTED. A user sees a tab only if the admin granted it
 * `view` or `edit` (plus `overview`, always visible as a read-only landing).
 * The `admin` role bypasses the overlay entirely. There is no role-based tab
 * special-casing -- whatever the admin sets per tab is what shows.
 */
export function allowedAccountingTabsForUser(
  roles: readonly string[],
  perms: FeaturePermissionsMap | null | undefined,
): AccountingTabId[] {
  if (roles.some((r) => BYPASS_PERMS_ROLES.has(r))) return [...ACCOUNTING_TAB_IDS];
  const accountingPerms = perms?.accounting ?? {};
  return ACCOUNTING_TAB_IDS.filter((tab) => {
    if (ALWAYS_VISIBLE_TABS.has(tab)) return true;
    const access = accountingPerms[TAB_TO_FEATURE[tab]];
    return access === 'view' || access === 'edit';
  });
}

/**
 * Whether the user may edit (mutate) within an accounting tab. Admins bypass;
 * everyone else needs an explicit `edit` grant on the tab's feature
 * (`overview` is read-only unless granted).
 */
export function canEditAccountingTab(
  tab: AccountingTabId,
  roles: readonly string[],
  perms: FeaturePermissionsMap | null | undefined,
): boolean {
  if (roles.some((r) => BYPASS_PERMS_ROLES.has(r))) return true;
  return perms?.accounting?.[TAB_TO_FEATURE[tab]] === 'edit';
}

export function canAccessAccountingTab(tab: string, roles: readonly string[]): tab is AccountingTabId {
  return allowedAccountingTabsForRoles(roles).includes(tab as AccountingTabId);
}

export function canAccessAccountingTabForUser(
  tab: string,
  roles: readonly string[],
  perms: FeaturePermissionsMap | null | undefined,
): tab is AccountingTabId {
  return allowedAccountingTabsForUser(roles, perms).includes(tab as AccountingTabId);
}

export function accountingTabToFeatureKey(tab: AccountingTabId): string {
  return TAB_TO_FEATURE[tab];
}
