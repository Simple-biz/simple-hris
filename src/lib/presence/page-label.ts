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

/**
 * Tab ids whose DISPLAY NAME has diverged from the id.
 *
 * This is deliberately not the per-dashboard label map `humanizeTabId` exists to
 * avoid — it is an exception table, and an id only earns an entry when its own
 * name can no longer be derived from it. That happens when a tab is renamed for
 * users while its id stays frozen as a persisted key.
 *
 * `hours` → "Time Adjustments" (renamed 2026-09-10): the id is the key in
 * `pages.visibility` and the employee app's render switch, so it cannot move
 * (src/lib/pages/visibility.ts:26-28). Without this entry the sidebar would read
 * "Time Adjustments" while the employee's own browser tab — and the Admin GML
 * live-status column — both said "Hours".
 */
const TAB_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  hours: 'Time Adjustments',
};

/** Generic kebab-case tab id -> Title Case fallback, e.g. `'new-hire-checklist'` ->
 *  `'New Hire Checklist'`. Used uniformly by every dashboard shell so none of them
 *  need to hand-maintain a separate label map just for presence; ids listed in
 *  {@link TAB_LABEL_OVERRIDES} resolve there first. */
export function humanizeTabId(tabId: string | null | undefined): string | null {
  const trimmed = (tabId ?? '').trim();
  if (!trimmed) return null;
  const override = TAB_LABEL_OVERRIDES[trimmed];
  if (override) return override;
  return trimmed
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
