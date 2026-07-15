'use client';

import { useEffect, useState } from 'react';
import { readCachedRoles, writeRbacCache } from '@/lib/rbac/rbac-cache';

export type AppView = 'employee' | 'admin' | 'accounting' | 'manager' | 'orphanage' | 'ceo' | 'hr' | 'contractor' | 'qc' | 'tickets';
export type Role =
  | 'hr_coordinator'
  | 'accounting'
  | 'admin'
  | 'manager'
  | 'orphanage_manager'
  | 'ceo'
  | 'contractor'
  | 'qc';

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
  qc: '/qc',
  tickets: '/tickets',
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
  qc: 'QC',
  tickets: 'Tickets',
};

// `tickets` sits below every real dashboard on purpose: it's a shared board,
// never anyone's default landing (a tickets-eligible role always carries at
// least one dashboard above it).
const VIEW_PRIORITY: AppView[] = ['admin', 'ceo', 'hr', 'accounting', 'orphanage', 'qc', 'manager', 'tickets', 'contractor', 'employee'];

export const ACTIVE_VIEW_KEY = 'active_view';
export const SESSION_EMAIL_KEY = 'employee_session_email';

export function viewsForRoles(roles: Role[]): AppView[] {
  // Admin = keys to the castle: EVERY dashboard, including their own employee
  // portal AND the contractor view, available together. Contractor is normally
  // an external-identity view that replaces the employee portal for non-staff,
  // but an admin can switch into it (to preview/operate the contractor surface)
  // without giving up the employee dashboard.
  if (roles.includes('admin')) {
    return [...VIEW_PRIORITY];
  }
  const set = new Set<AppView>();
  if (!roles.includes('contractor')) set.add('employee');
  if (roles.includes('admin')) set.add('admin');
  if (roles.includes('ceo')) set.add('ceo');
  if (roles.some((r) => ACCOUNTING_ROLES.includes(r))) set.add('accounting');
  if (roles.includes('orphanage_manager')) set.add('orphanage');
  if (roles.includes('manager')) set.add('manager');
  // QC is a manager's-assistant dashboard. A QC person normally holds ONLY the
  // `qc` role (Admin warns against also granting `manager`), so the switcher
  // shows just "QC" and the Manager view never appears for them.
  if (roles.includes('qc')) set.add('qc');
  if (roles.includes('admin') || roles.includes('hr_coordinator')) set.add('hr');
  if (roles.includes('contractor')) set.add('contractor');
  // The shared HRIS-updates ticket board — every role that may open /tickets
  // gets it in the switcher (mirrors ROUTE_REQUIRED_ROLES in route-access.ts).
  if (roles.some((r) => (['accounting', 'hr_coordinator', 'manager', 'ceo'] as Role[]).includes(r))) {
    set.add('tickets');
  }
  return VIEW_PRIORITY.filter((v) => set.has(v));
}

export function defaultViewFor(views: AppView[]): AppView {
  return views[0] ?? 'employee';
}

export function useAvailableViews(
  email: string | null | undefined,
  /**
   * The signed-in user's own roles, read from the NextAuth session (JWT) by the
   * ViewSwitcher. Passed ONLY when the switcher is showing the session owner's
   * own views — not when an admin is browsing `?email=someone-else`. Because the
   * JWT already carries roles without a Supabase hit, this keeps the switcher
   * alive through a Supabase outage (the roles fetch below fails, but we still
   * know what this user can access).
   */
  fallbackRoles?: readonly Role[] | null,
) {
  const [views, setViews] = useState<AppView[]>(['employee']);
  const [loading, setLoading] = useState(false);

  // Stable dependency so a new session-array identity each render doesn't loop.
  const fallbackKey = (fallbackRoles ?? []).join(',');

  useEffect(() => {
    let cancelled = false;
    const e = (email || '').trim();
    if (!e) {
      setViews(['employee']);
      return;
    }

    // Offline-first: session JWT roles (authoritative, no DB) then last-known-good
    // cache. Seed immediately so a multi-view user sees the switcher even before —
    // or entirely without — a successful roles fetch.
    const offlineRoles =
      fallbackRoles && fallbackRoles.length > 0
        ? [...fallbackRoles]
        : readCachedRoles(e);
    if (offlineRoles && offlineRoles.length > 0) {
      const seeded = viewsForRoles(offlineRoles as Role[]);
      if (seeded.length > 0) setViews(seeded);
    }

    setLoading(true);
    fetch(`/api/employee-roles?email=${encodeURIComponent(e)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`roles ${r.status}`))))
      .then((j: { rows?: { role: Role }[] }) => {
        if (cancelled) return;
        // Guard an error-shaped 200 body — don't clobber good state with nothing.
        if (!Array.isArray(j.rows)) return;
        const roles = j.rows.map((r) => r.role);
        setViews(viewsForRoles(roles));
        writeRbacCache(e, { roles });
      })
      .catch(() => {
        if (cancelled) return;
        // Supabase unreachable: keep whatever we seeded. Fall all the way back to
        // employee-only only when we truly know nothing about this user.
        const fb =
          fallbackRoles && fallbackRoles.length > 0
            ? [...fallbackRoles]
            : readCachedRoles(e);
        setViews(fb && fb.length > 0 ? viewsForRoles(fb as Role[]) : ['employee']);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, fallbackKey]);

  return { views, loading };
}
