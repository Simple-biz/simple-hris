import type { FeatureAccess, FeaturePermissionsMap, FeatureViewKey } from '@/lib/rbac/feature-permissions';

/**
 * Generic per-view tab gating, built on the `employee_feature_permissions`
 * overlay (hidden | view | edit). This is the single source of truth that the
 * accounting helper (`accounting-tabs.ts`) and every dashboard sidebar/app
 * build on, so all six views gate identically.
 *
 * Model (attribute-based, default-deny) — applies to EVERY dashboard:
 * a tab is visible only when the admin granted it `view` or `edit` in the
 * per-tab permission grid; the default (no row) is hidden. Assigning a dashboard
 * role AUTO-PROVISIONS all its tabs to `edit` (see the employee-roles grant
 * route), so a freshly-assigned dashboard is instantly usable — the admin then
 * downgrades a tab to `view` or hides it. Two deliberate exceptions:
 *   - `admin` role bypasses gating entirely (sees + edits everything).
 *   - the `overview` tab is a read-only FALLBACK landing: it shows only when the
 *     overlay would otherwise grant the user NO tabs (legacy/unprovisioned
 *     accounts), so a dashboard is never fully blank. Once the user has any other
 *     granted tab, `overview` obeys the overlay like every other tab — so an
 *     admin CAN hide it. (It is NOT an unconditional always-on tab; that made the
 *     "hide Overview" grid setting a silent no-op.)
 *
 * Pure logic only (no runtime import of the server-side feature-permissions
 * module) so this is safe to use in client bundles. Types are imported with
 * `import type`, which is erased at build time.
 */

/** Ordered UI tab ids per view. The feature key is the tab id with dashes
 *  turned into underscores (see {@link tabFeatureKey}); this holds for every
 *  tab across all views, so we store ids only. */
export const VIEW_TAB_IDS: Record<FeatureViewKey, readonly string[]> = {
  accounting: [
    'overview',
    'people',
    'payroll-wizard',
    'payment-dispatch',
    'disputes',
    'transfers',
    'mesa',
    'announcements',
    'notifications',
    's-wall',
    'settings',
  ],
  hr: [
    'overview',
    'global-master-list',
    'screening',
    'new-hire-checklist',
    'onboarding',
    'offboarding',
    'leaves',
    'transfers',
    'gift-tracker',
    'mesa',
    'announcements',
    'notifications',
    's-wall',
  ],
  manager: [
    'overview',
    'time-adjustments',
    'leaves',
    'team',
    'transfers',
    'announcements',
    's-wall',
    'hsl-bonus',
    'bonus-history',
    'notifications',
  ],
  orphanage: [
    'overview',
    'queue',
    'budget',
    'budget-history',
    'third-party-vendors',
    'notifications',
    's-wall',
  ],
  ceo: [
    'overview',
    'financial-reports',
    'biz-ai',
    'people',
    'announcements',
    'notifications',
    's-wall',
  ],
  contractor: [
    'overview',
    'profile',
    'invoices',
  ],
  qc: [
    'overview',
    'qc-calculator',
    'notifications',
  ],
  // /tickets is a single-surface board, not a tabbed dashboard — no tab ids.
  // Its access is checked via the `tickets` feature key directly (API layer).
  tickets: [],
};

/** Roles that bypass the per-tab overlay and always see/edit every tab. */
const BYPASS_PERMS_ROLES = new Set(['admin']);

/** Read-only FALLBACK tabs: shown only when the overlay grants nothing else, so
 *  a dashboard is never blank. NOT unconditionally visible — an admin can hide
 *  these as long as the user still has at least one other granted tab. */
const FALLBACK_TABS = new Set(['overview']);

/** UI tab id -> feature key stored in `employee_feature_permissions`. */
export function tabFeatureKey(tabId: string): string {
  return tabId.replace(/-/g, '_');
}

function hasBypass(roles: readonly string[]): boolean {
  return roles.some((r) => BYPASS_PERMS_ROLES.has(r));
}

function resolve(
  perms: FeaturePermissionsMap | null | undefined,
  view: FeatureViewKey,
  feature: string,
): FeatureAccess {
  return perms?.[view]?.[feature] ?? 'hidden';
}

/** Visible tab ids for a user, in catalog order. */
export function allowedTabsForUser(
  view: FeatureViewKey,
  roles: readonly string[],
  perms: FeaturePermissionsMap | null | undefined,
): string[] {
  const ids = VIEW_TAB_IDS[view] ?? [];
  if (hasBypass(roles)) return [...ids];
  const granted = ids.filter((tabId) => {
    const access = resolve(perms, view, tabFeatureKey(tabId));
    return access === 'view' || access === 'edit';
  });
  // Honor the overlay exactly when it grants at least one tab — this is what lets
  // an admin hide `overview` (the user simply lands on their first other tab).
  if (granted.length > 0) return granted;
  // Overlay grants nothing (legacy/unprovisioned, or every tab hidden): fall back
  // to the read-only landing so the dashboard is never fully blank.
  return ids.filter((tabId) => FALLBACK_TABS.has(tabId));
}

/** Whether a tab is visible to a user. Delegates to {@link allowedTabsForUser}
 *  so the fallback-landing rule for `overview` is applied consistently. */
export function canAccessTabForUser(
  view: FeatureViewKey,
  tabId: string,
  roles: readonly string[],
  perms: FeaturePermissionsMap | null | undefined,
): boolean {
  if (hasBypass(roles)) return true;
  return allowedTabsForUser(view, roles, perms).includes(tabId);
}

/** Whether a user may edit (mutate) within a tab. Admin bypasses; otherwise
 *  requires an explicit `edit` grant. `overview` is read-only unless granted. */
export function canEditTab(
  view: FeatureViewKey,
  tabId: string,
  roles: readonly string[],
  perms: FeaturePermissionsMap | null | undefined,
): boolean {
  if (hasBypass(roles)) return true;
  return resolve(perms, view, tabFeatureKey(tabId)) === 'edit';
}
