'use client';

import { useEffect, useState } from 'react';

export type AppView = 'employee' | 'admin' | 'accounting' | 'manager' | 'orphanage';
export type Role =
  | 'viewer'
  | 'hr_coordinator'
  | 'payroll_coordinator'
  | 'payroll_manager'
  | 'finance'
  | 'admin'
  | 'manager'
  | 'orphanage_manager';

const ACCOUNTING_ROLES: Role[] = [
  'payroll_coordinator',
  'payroll_manager',
  'finance',
  'hr_coordinator',
  'viewer',
];

export const VIEW_ROUTES: Record<AppView, string> = {
  employee: '/employee',
  admin: '/admin',
  accounting: '/accounting',
  manager: '/manager',
  orphanage: '/orphanage',
};

export const VIEW_LABELS: Record<AppView, string> = {
  employee: 'Employee',
  admin: 'Admin',
  accounting: 'Accounting',
  manager: 'Manager',
  orphanage: 'Orphanage',
};

const VIEW_PRIORITY: AppView[] = ['admin', 'accounting', 'orphanage', 'manager', 'employee'];

export const ACTIVE_VIEW_KEY = 'active_view';
export const SESSION_EMAIL_KEY = 'employee_session_email';

export function viewsForRoles(roles: Role[]): AppView[] {
  const set = new Set<AppView>(['employee']);
  if (roles.includes('admin')) set.add('admin');
  if (roles.some((r) => ACCOUNTING_ROLES.includes(r))) set.add('accounting');
  if (roles.includes('orphanage_manager')) set.add('orphanage');
  if (roles.includes('manager')) set.add('manager');
  return VIEW_PRIORITY.filter((v) => set.has(v));
}

export function defaultViewFor(views: AppView[]): AppView {
  return views[0] ?? 'employee';
}

export function useAvailableViews(email: string | null | undefined) {
  const [views, setViews] = useState<AppView[]>(['employee']);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const e = (email || '').trim();
    if (!e) {
      setViews(['employee']);
      return;
    }
    setLoading(true);
    fetch(`/api/employee-roles?email=${encodeURIComponent(e)}`)
      .then((r) => r.json())
      .then((j: { rows?: { role: Role }[] }) => {
        if (cancelled) return;
        const roles = (j.rows ?? []).map((r) => r.role);
        setViews(viewsForRoles(roles));
      })
      .catch(() => {
        if (!cancelled) setViews(['employee']);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [email]);

  return { views, loading };
}
