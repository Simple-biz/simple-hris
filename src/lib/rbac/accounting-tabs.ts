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
  if (roles.some((role) => FULL_ACCOUNTING_ACCESS_ROLES.has(role))) {
    return [...ACCOUNTING_TAB_IDS];
  }

  if (roles.includes('payroll_manager')) {
    return ['overview', 'payment-dispatch'];
  }

  return [...ACCOUNTING_TAB_IDS];
}

export function canAccessAccountingTab(tab: string, roles: readonly string[]): tab is AccountingTabId {
  return allowedAccountingTabsForRoles(roles).includes(tab as AccountingTabId);
}
