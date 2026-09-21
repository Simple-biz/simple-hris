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
    'documents',
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
    'scheduling',
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
    'interns',
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
  //
  // THIS STAYS EMPTY, and that is load-bearing in three ways. Employee Support
  // now shares the /tickets ROUTE, but its tabs live in the `employee_support`
  // catalog below, never here:
  //   1. A tab id listed here is gated by the `tickets` overlay, which the
  //      `tickets` role auto-provisions to `edit` wholesale — support tabs here
  //      would ship with the dev board, which is the arrangement Kane rejected.
  //   2. Listing `overview` here would arm the FALLBACK_TABS landing below for
  //      every user the `tickets` overlay grants nothing — including an
  //      un-provisioned `employee_support` holder, who would land on the dev
  //      board's Overview. That is the specific trap this surface was scoped
  //      against.
  //   3. Any id here changes what today's `tickets` holders see:
  //      allowedTabsForUser('tickets', …) returns [] for EVERYONE right now,
  //      admins included, and the board renders from its own rail instead.
  tickets: [],
  // Employee Support — its own tabs, hosted at /tickets (Kane's Q3). It carries
  // NO `overview` ON PURPOSE: see FALLBACK_TABS. With no fallback id in this
  // list, an `employee_support` holder whose overlay grants nothing gets [] —
  // an empty support surface — instead of being landed somewhere nobody granted
  // them. Plan task 8.
  employee_support: ['support-chat'],
};

/** Roles that bypass the per-tab overlay and always see/edit every tab. */
const BYPASS_PERMS_ROLES = new Set(['admin']);

/** Read-only FALLBACK tabs: shown only when the overlay grants nothing else, so
 *  a dashboard is never blank. NOT unconditionally visible — an admin can hide
 *  these as long as the user still has at least one other granted tab.
 *
 *  Exported so a view that must never fall back can be PINNED against it: a
 *  view whose ids include none of these returns [] for an un-provisioned user
 *  rather than landing them on a tab nobody granted. `employee_support` is
 *  exactly that view, and src/lib/rbac/view-tabs.test.ts asserts the two lists
 *  stay disjoint — so adding `overview` to the support tabs fails a test
 *  instead of quietly opening a door. */
export const FALLBACK_TABS: ReadonlySet<string> = new Set(['overview']);

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

// ---------------------------------------------------------------------------
// The /tickets host surface — two unrelated dashboards on one route
// ---------------------------------------------------------------------------

/** Roles that see the dev Kanban's own rail (Overview / Board / Archived).
 *
 *  This is EXACTLY the set that could open /tickets before Employee Support was
 *  hosted there (route-access.ts, the `/tickets` entry, pre-2026-09-19), and the
 *  rail was ungated inside — so reproducing that set here is what keeps an
 *  existing `tickets` holder's access bit-for-bit unchanged. `employee_support`
 *  is deliberately absent. The board's data is separately gated on the `tickets`
 *  feature key at the API layer (app/api/tickets/route.ts:28), which this does
 *  not touch or weaken. */
const TICKET_BOARD_ROLES: ReadonlySet<string> = new Set(['tickets', 'admin']);

/** Roles that see the Employee Support tabs. Required IN ADDITION to the
 *  overlay grant, because the server requires both: requireFeatureAccessAnyView
 *  walks the caller's ROLES and resolves the feature only under each role's view
 *  (authorize-feature.ts:119-128), so a stray `employee_support` overlay row on
 *  somebody who does not hold the role buys nothing server-side. Consulting the
 *  role here too keeps the UI from drawing a tab whose every fetch would 403. */
const SUPPORT_ROLES: ReadonlySet<string> = new Set(['employee_support', 'admin']);

/** What the /tickets host must render on arrival — including on a typed URL,
 *  which is the only way in (the board's Overview/Board/Archived are component
 *  state, not routes: TicketsBoard.tsx:96). */
export type TicketsHostLanding =
  /** The dev Kanban, which opens on its own Overview. */
  | { kind: 'board' }
  /** The first Employee Support tab this user was actually granted. */
  | { kind: 'support'; tabId: string }
  /** Nothing was granted. Render an empty state — NEVER a default tab. */
  | { kind: 'none' };

export interface TicketsHostAccess {
  /** May this user see the dev Kanban rail at all? */
  board: boolean;
  /** Employee Support tab ids this user may open, in catalog order. */
  supportTabs: string[];
  /** Where the surface opens. */
  landing: TicketsHostLanding;
}

/**
 * Who sees what on /tickets, now that two unrelated surfaces share the route:
 * the HRIS dev Kanban (`tickets` role) and Employee Support (`employee_support`
 * role, Kane's Q3). One function so the sidebar's nav, the page's landing and
 * any guard inside cannot disagree with each other.
 *
 * The rules it encodes:
 *   - A support-only holder gets `board: false`. They never see Overview /
 *     Board / Archived — not in the rail, and not as a landing, which is the
 *     only way a typed /tickets URL could have reached them.
 *   - A `tickets` holder gets exactly what they got before: the rail, landing on
 *     the board. Their `supportTabs` is [] unless someone also granted them
 *     `employee_support`, because the support ids live in a catalog their roles
 *     do not map to.
 *   - An un-provisioned support holder (role granted, overlay rows missing or
 *     all hidden) gets `{ kind: 'none' }`, NOT a fallback tab — see
 *     FALLBACK_TABS and VIEW_TAB_IDS.employee_support.
 *   - A support tab needs BOTH the role and the overlay grant, matching the
 *     server's role-walk exactly — see SUPPORT_ROLES.
 *   - `admin` keeps the keys to the castle: rail + every support tab.
 *
 * Pure and client-safe, like the rest of this module. It decides what to DRAW;
 * every fetch behind either surface is separately gated server-side.
 */
export function ticketsHostAccess(
  roles: readonly string[],
  perms: FeaturePermissionsMap | null | undefined,
): TicketsHostAccess {
  const board = roles.some((r) => TICKET_BOARD_ROLES.has(r));
  const supportTabs = roles.some((r) => SUPPORT_ROLES.has(r))
    ? allowedTabsForUser('employee_support', roles, perms)
    : [];
  // Board first for a dual-role holder: that is where they landed yesterday.
  const landing: TicketsHostLanding = board
    ? { kind: 'board' }
    : supportTabs.length > 0
      ? { kind: 'support', tabId: supportTabs[0] }
      : { kind: 'none' };
  return { board, supportTabs, landing };
}
