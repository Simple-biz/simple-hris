'use client';

export const ACCOUNTING_TAB_IDS = [
  'overview',
  'rates',
  'payroll-wizard',
  'hogan-suite',
  'payment-dispatch',
  'leave-requests',
  'disputes',
  'orphanage-visits',
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

export function canAccessAccountingTab(tab: string, roles: readonly string[]): tab is AccountingTabId {
  return allowedAccountingTabsForRoles(roles).includes(tab as AccountingTabId);
}
