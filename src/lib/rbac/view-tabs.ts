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
 *   - the `overview` tab is always visible (read-only landing) so a dashboard
 *     is never fully blank.
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
    'mesa',
    'announcements',
    'notifications',
    's-wall',
    'settings',
  ],
  hr: [
    'overview',
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
    'notifications',
    's-wall',
  ],
  ceo: [
    'overview',
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
};

/** Roles that bypass the per-tab overlay and always see/edit every tab. */
const BYPASS_PERMS_ROLES = new Set(['admin']);

/** Tabs that are always visible regardless of the overlay (read-only landing). */
const ALWAYS_VISIBLE_TABS = new Set(['overview']);

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
  return ids.filter((tabId) => {
    if (ALWAYS_VISIBLE_TABS.has(tabId)) return true;
    const access = resolve(perms, view, tabFeatureKey(tabId));
    return access === 'view' || access === 'edit';
  });
}

/** Whether a tab is visible to a user. */
export function canAccessTabForUser(
  view: FeatureViewKey,
  tabId: string,
  roles: readonly string[],
  perms: FeaturePermissionsMap | null | undefined,
): boolean {
  if (hasBypass(roles)) return true;
  if (ALWAYS_VISIBLE_TABS.has(tabId)) return true;
  const access = resolve(perms, view, tabFeatureKey(tabId));
  return access === 'view' || access === 'edit';
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
