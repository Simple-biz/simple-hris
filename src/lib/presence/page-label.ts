/**
 * Human-readable labels for "where is this person right now", used by the
 * Admin Global Master List live-status column. Pure/side-effect-free.
 */

/** Mirrors the dashboard prefixes in `src/lib/auth/route-access.ts` (kept
 *  separate — that file is edge/auth-focused and intentionally pure of any
 *  display concerns). */
const DASHBOARD_LABELS: ReadonlyArray<{ prefix: string; label: string }> = [
  { prefix: '/admin', label: 'Admin' },
  { prefix: '/ceo', label: 'CEO' },
  { prefix: '/accounting', label: 'Accounting' },
  { prefix: '/payroll-clerk', label: 'Payroll Clerk' },
  { prefix: '/hr', label: 'HR Dashboard' },
  { prefix: '/orphanage', label: 'Orphanage' },
  { prefix: '/manager', label: 'Manager' },
  { prefix: '/qc', label: 'QC' },
  { prefix: '/employee', label: 'Employee Portal' },
  { prefix: '/contractor', label: 'Contractor Portal' },
  { prefix: '/login', label: 'Login' },
  { prefix: '/onboarding', label: 'Onboarding' },
  { prefix: '/update-bank-info', label: 'Bank Info Update' },
  { prefix: '/auth-callback', label: 'Signing in…' },
];

/** The dashboard/section name for a pathname, e.g. `/hr/foo` -> "HR Dashboard". */
export function dashboardLabelForPathname(pathname: string | null | undefined): string {
  if (!pathname) return 'Simple HRIS';
  const match = DASHBOARD_LABELS.find(
    (d) => pathname === d.prefix || pathname.startsWith(`${d.prefix}/`),
  );
  return match?.label ?? 'Simple HRIS';
}

/** Generic kebab-case tab id -> Title Case fallback, e.g. `'new-hire-checklist'` ->
 *  `'New Hire Checklist'`. Used uniformly by every dashboard shell so none of them
 *  need to hand-maintain a separate label map just for presence. */
export function humanizeTabId(tabId: string | null | undefined): string | null {
  const trimmed = (tabId ?? '').trim();
  if (!trimmed) return null;
  return trimmed
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
