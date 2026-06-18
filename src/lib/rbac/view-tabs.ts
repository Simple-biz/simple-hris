import type { FeatureAccess, FeaturePermissionsMap, FeatureViewKey } from '@/lib/rbac/feature-permissions';

/**
 * Generic per-view tab gating, built on the `employee_feature_permissions`
 * overlay (hidden | view | edit). This is the single source of truth that the
 * accounting helper (`accounting-tabs.ts`) and every dashboard sidebar/app
 * build on, so all six views gate identically.
 *
 * Model — two regimes:
 *   1. ROLE GRANTS FULL ACCESS (single-role dashboards: manager, hr, orphanage,
 *      ceo, contractor). Holding the dashboard's role grants view+edit on every
 *      tab by default — assigning the role IS the grant, no per-tab provisioning.
 *      The overlay can still DOWNGRADE one tab to read-only (an explicit `view`
 *      row) for such a user, but absence of a row means full access, not hidden.
 *   2. HIDDEN UNTIL GRANTED (accounting only). A tab is visible only when the
 *      admin granted `view`/`edit`; the default (no row) is hidden. Accounting
 *      keeps this stricter model because it has many sub-roles (payroll,
 *      finance, viewer, …) and sensitive money tabs.
 * Two deliberate exceptions across both regimes:
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
    'rates',
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
    'announcements',
    'notifications',
    's-wall',
  ],
  contractor: [
    'overview',
    'profile',
    'invoices',
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

/**
 * Single-role dashboards where holding the dashboard's role grants full access
 * to every tab by default. Assigning the role is the grant — no per-tab
 * provisioning needed. Keep in sync with the server mirror in
 * `src/lib/auth/authorize-feature.ts`. Accounting is intentionally absent.
 */
const ROLE_BASELINE_VIEW_ROLES: Partial<Record<FeatureViewKey, readonly string[]>> = {
  manager: ['manager'],
  hr: ['hr_coordinator'],
  orphanage: ['orphanage_manager'],
  ceo: ['ceo'],
  contractor: ['contractor'],
};

/** True when the user holds a role that grants full default access to `view`. */
function roleGrantsFullView(view: FeatureViewKey, roles: readonly string[]): boolean {
  const grantRoles = ROLE_BASELINE_VIEW_ROLES[view];
  return !!grantRoles && roles.some((r) => grantRoles.includes(r));
}

/**
 * The user's effective access to a (view, tab):
 *   - admin → `edit` (full bypass)
 *   - role grants the view → `edit` by default; an explicit `view` row
 *     downgrades that single tab to read-only
 *   - otherwise (accounting / non-holder) → exactly what the overlay granted,
 *     with `overview` always at least visible (read-only landing).
 */
function effectiveAccess(
  view: FeatureViewKey,
  tabId: string,
  roles: readonly string[],
  perms: FeaturePermissionsMap | null | undefined,
): FeatureAccess {
  if (hasBypass(roles)) return 'edit';
  const explicit = resolve(perms, view, tabFeatureKey(tabId));
  if (roleGrantsFullView(view, roles)) {
    // Role grants everything; the only override honored today is a deliberate
    // downgrade to read-only.
    return explicit === 'view' ? 'view' : 'edit';
  }
  if (ALWAYS_VISIBLE_TABS.has(tabId)) return explicit === 'edit' ? 'edit' : 'view';
  return explicit;
}

/** Visible tab ids for a user, in catalog order. */
export function allowedTabsForUser(
  view: FeatureViewKey,
  roles: readonly string[],
  perms: FeaturePermissionsMap | null | undefined,
): string[] {
  const ids = VIEW_TAB_IDS[view] ?? [];
  return ids.filter((tabId) => effectiveAccess(view, tabId, roles, perms) !== 'hidden');
}

/** Whether a tab is visible to a user. */
export function canAccessTabForUser(
  view: FeatureViewKey,
  tabId: string,
  roles: readonly string[],
  perms: FeaturePermissionsMap | null | undefined,
): boolean {
  return effectiveAccess(view, tabId, roles, perms) !== 'hidden';
}

/** Whether a user may edit (mutate) within a tab. Admin bypasses; a role that
 *  grants the view confers edit by default; otherwise an explicit `edit` grant
 *  is required (`overview` is read-only unless granted). */
export function canEditTab(
  view: FeatureViewKey,
  tabId: string,
  roles: readonly string[],
  perms: FeaturePermissionsMap | null | undefined,
): boolean {
  return effectiveAccess(view, tabId, roles, perms) === 'edit';
}
