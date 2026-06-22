'use client';

import { useEffect, useState } from 'react';

export type AppView = 'employee' | 'admin' | 'accounting' | 'manager' | 'orphanage' | 'ceo' | 'hr' | 'contractor';
export type Role =
  | 'hr_coordinator'
  | 'accounting'
  | 'admin'
  | 'manager'
  | 'orphanage_manager'
  | 'ceo'
  | 'contractor';

// Roles that unlock the Accounting dashboard. `accounting` is the dedicated
// dashboard role (renamed from the old `finance`). `hr_coordinator` was
// decoupled from Accounting on 2026-06-22 — HR coordinators keep the HR
// dashboard but no longer surface the Accounting view. The legacy
// payroll_coordinator / payroll_manager / viewer roles were retired 2026-06-18
// (roles are now strictly dashboard access).
const ACCOUNTING_ROLES: Role[] = [
  'accounting',
];

export const VIEW_ROUTES: Record<AppView, string> = {
  employee: '/employee',
  admin: '/admin',
  accounting: '/accounting',
  manager: '/manager',
  orphanage: '/orphanage',
  ceo: '/ceo',
  hr: '/hr',
  contractor: '/contractor',
};

export const VIEW_LABELS: Record<AppView, string> = {
  employee: 'Employee',
  admin: 'Admin',
  accounting: 'Accounting',
  manager: 'Manager',
  orphanage: 'Orphanage',
  ceo: 'CEO',
  hr: 'HR',
  contractor: 'Contractor',
};

const VIEW_PRIORITY: AppView[] = ['admin', 'ceo', 'hr', 'accounting', 'orphanage', 'manager', 'contractor', 'employee'];

export const ACTIVE_VIEW_KEY = 'active_view';
export const SESSION_EMAIL_KEY = 'employee_session_email';

export function viewsForRoles(roles: Role[]): AppView[] {
  // Admin = keys to the castle: every management dashboard plus their own
  // employee portal. Contractor is an external-identity view (it replaces the
  // employee portal for non-staff), not a management surface, so it's the one
  // dashboard an admin is not dropped into.
  if (roles.includes('admin')) {
    return VIEW_PRIORITY.filter((v) => v !== 'contractor');
  }
  const set = new Set<AppView>();
  if (!roles.includes('contractor')) set.add('employee');
  if (roles.includes('admin')) set.add('admin');
  if (roles.includes('ceo')) set.add('ceo');
  if (roles.some((r) => ACCOUNTING_ROLES.includes(r))) set.add('accounting');
  if (roles.includes('orphanage_manager')) set.add('orphanage');
  if (roles.includes('manager')) set.add('manager');
  if (roles.includes('admin') || roles.includes('hr_coordinator')) set.add('hr');
  if (roles.includes('contractor')) set.add('contractor');
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
