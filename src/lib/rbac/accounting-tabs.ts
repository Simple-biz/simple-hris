'use client';

import type { FeaturePermissionsMap } from '@/lib/rbac/feature-permissions';

export const ACCOUNTING_TAB_IDS = [
  'overview',
  'rates',
  'payroll-wizard',
  'payment-dispatch',
  'disputes',
  'announcements',
  's-wall',
  'settings',
] as const;

export type AccountingTabId = (typeof ACCOUNTING_TAB_IDS)[number];

const FULL_ACCOUNTING_ACCESS_ROLES = new Set([
  'admin',
  'finance',
  'hr_coordinator',
  'payroll_coordinator',
  'viewer',
]);

/** UI tab id → feature key stored in `employee_feature_permissions`. */
const TAB_TO_FEATURE: Record<AccountingTabId, string> = {
  'overview': 'overview',
  'rates': 'rates',
  'payroll-wizard': 'payroll_wizard',
  'payment-dispatch': 'payment_dispatch',
  'disputes': 'disputes',
  'announcements': 'announcements',
  's-wall': 's_wall',
  'settings': 'settings',
};

/**
 * Roles that automatically receive every accounting tab, ignoring the
 * `employee_feature_permissions` overlay. Used as a backstop so locking
 * yourself out is hard — admins always see everything.
 */
const BYPASS_PERMS_ROLES = new Set(['admin']);

export function allowedAccountingTabsForRoles(roles: readonly string[]): AccountingTabId[] {
  const hasPrivilegedAccountingRole = roles.some((role) =>
    role === 'admin' ||
    role === 'finance' ||
    role === 'hr_coordinator' ||
    role === 'payroll_coordinator',
  );

  if (roles.includes('payroll_manager') && !hasPrivilegedAccountingRole) {
    return ['overview', 'payment-dispatch', 'disputes'];
  }

  if (roles.some((role) => FULL_ACCOUNTING_ACCESS_ROLES.has(role))) {
    return [...ACCOUNTING_TAB_IDS];
  }

  return [...ACCOUNTING_TAB_IDS];
}

/**
 * Tab list after the per-user feature-permission overlay is applied. Tabs the
 * user hasn't been granted (no `view` or `edit` row in `employee_feature_permissions`)
 * are filtered out. Admins always see every tab regardless of the overlay.
 */
export function allowedAccountingTabsForUser(
  roles: readonly string[],
  perms: FeaturePermissionsMap | null | undefined,
): AccountingTabId[] {
  const base = allowedAccountingTabsForRoles(roles);
  if (roles.some((r) => BYPASS_PERMS_ROLES.has(r))) return base;
  const accountingPerms = perms?.accounting ?? {};
  return base.filter((tab) => {
    const featureKey = TAB_TO_FEATURE[tab];
    const access = accountingPerms[featureKey];
    return access === 'view' || access === 'edit';
  });
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
