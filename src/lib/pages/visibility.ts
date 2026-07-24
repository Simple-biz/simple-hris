/**
 * Pages visibility — a GLOBAL, admin-controlled overlay that lets an admin mark
 * any dashboard sidebar tab as visible / under construction / hidden, for ALL
 * users of that dashboard at once.
 *
 * This is deliberately SEPARATE from the per-user feature-permission overlay
 * (`employee_feature_permissions`, see {@link file://../rbac/view-tabs.ts}):
 *   - feature permissions are per-user, per-tab access grants (hidden|view|edit)
 *   - pages visibility is a single workspace-wide broadcast that an admin flips
 *
 * The two layers compose. A tab renders only when it is allowed by the viewer's
 * feature permissions AND not `hidden` here; a `construction` page is shown to
 * everyone who could otherwise see it.
 *
 *   visible      — normal behavior (still subject to per-user feature perms)
 *   construction — the nav item stays (with a badge) but the page body is
 *                  replaced by an "Under Construction" graphic
 *   hidden       — the nav item disappears; the dashboard redirects off it if it
 *                  was the active tab
 *
 * Persisted under the `pages.visibility` key in `app_settings`. That table's
 * `value` column is TEXT holding a JSON string (NOT jsonb), so callers must
 * JSON.parse / JSON.stringify — see {@link parsePagesVisibility} /
 * {@link serializePagesVisibility}.
 *
 * The `key` of every {@link PageEntry} is the dashboard's own tab id, matching
 * the sidebar registry + app render switch 1:1 (no transformation), so a single
 * lookup gates both the nav item and the content.
 */

/** app_settings key holding the JSON-encoded {@link PagesVisibilityConfig}. */
export const PAGES_VISIBILITY_KEY = 'pages.visibility';

export type PageVisibility = 'visible' | 'construction' | 'hidden';

export type DashboardKey = 'ceo' | 'hr' | 'accounting' | 'manager' | 'employee';

/** dashboard key -> (tab id -> visibility). A missing entry means `visible`. */
export type PagesVisibilityConfig = Partial<Record<DashboardKey, Record<string, PageVisibility>>>;

export interface PageEntry {
  /** The dashboard's own tab id (matches the sidebar/app switch key 1:1). */
  key: string;
  label: string;
  /** The dashboard's landing tab. Disabling it is allowed but discouraged. */
  home?: boolean;
}

/** Accent used by the admin editor to colour each dashboard section. */
export type DashboardAccent = 'amber' | 'emerald' | 'orange' | 'blue';

export interface DashboardPages {
  key: DashboardKey;
  label: string;
  accent: DashboardAccent;
  pages: PageEntry[];
}

/**
 * The canonical list of editable pages per dashboard, mirroring each dashboard's
 * sidebar registry. Keep these tab ids and labels in sync with:
 *   ceo        -> src/components/ceo/CeoSidebar.tsx        (CeoTab)
 *   hr         -> src/components/hr/HrSidebar.tsx          (HrTab)
 *   accounting -> src/components/Sidebar.tsx               (navItems) + s-wall
 *   manager    -> src/components/manager/ManagerSidebar.tsx (ManagerTab)
 *   employee   -> src/components/employee/EmployeeSidebar.tsx (navItems) + s-wall
 */
export const DASHBOARD_PAGES: DashboardPages[] = [
  {
    key: 'ceo',
    label: 'CEO',
    accent: 'amber',
    pages: [
      { key: 'overview', label: 'Overview', home: true },
      { key: 'financial-reports', label: 'Financial Reports' },
      { key: 'biz-ai', label: 'Penny AI' },
      { key: 'people', label: 'People' },
      { key: 'announcements', label: 'Announcements' },
      { key: 'notifications', label: 'Notifications' },
      { key: 's-wall', label: 'S-Wall' },
    ],
  },
  {
    key: 'hr',
    label: 'HR',
    accent: 'emerald',
    pages: [
      { key: 'overview', label: 'Overview', home: true },
      { key: 'global-master-list', label: 'Global Master List' },
      { key: 'screening', label: 'Screening' },
      { key: 'new-hire-checklist', label: 'New Hire Checklist' },
      { key: 'onboarding', label: 'Onboarding' },
      { key: 'offboarding', label: 'Offboarding' },
      { key: 'leaves', label: 'Leave Requests' },
      { key: 'transfers', label: 'Transfers' },
      { key: 'gift-tracker', label: 'Gift Tracker' },
      { key: 'mesa', label: 'MESA' },
      { key: 'announcements', label: 'Announcements' },
      { key: 'notifications', label: 'Notifications' },
      { key: 's-wall', label: 'S-Wall' },
    ],
  },
  {
    key: 'accounting',
    label: 'Accounting',
    accent: 'orange',
    pages: [
      { key: 'overview', label: 'Overview', home: true },
      { key: 'people', label: 'People' },
      { key: 'hr', label: 'HR' },
      { key: 'payroll-wizard', label: 'Payroll Wizard' },
      { key: 'bonus-catalog', label: 'Payment Catalog' },
      { key: 'payment-dispatch', label: 'Payment Dispatch' },
      { key: 'disputes', label: 'Issues' },
      { key: 'transfers', label: 'Transfers' },
      { key: 'mesa', label: 'MESA' },
      { key: 'documents', label: 'Documents' },
      { key: 'announcements', label: 'Announcements' },
      { key: 'notifications', label: 'Notifications' },
      { key: 's-wall', label: 'S-Wall' },
      { key: 'settings', label: 'System Settings' },
    ],
  },
  {
    key: 'manager',
    label: 'Manager',
    accent: 'blue',
    pages: [
      { key: 'overview', label: 'Overview', home: true },
      { key: 'time-adjustments', label: 'Time Adjustments' },
      { key: 'leaves', label: 'Leaves' },
      { key: 'team', label: 'My Team' },
      { key: 'transfers', label: 'Transfers' },
      { key: 'announcements', label: 'Announcements' },
      { key: 's-wall', label: 'S-Wall' },
      { key: 'hsl-bonus', label: 'KPI Calculator' },
      { key: 'bonus-history', label: 'Bonus History' },
      { key: 'notifications', label: 'Notifications' },
    ],
  },
  {
    key: 'employee',
    label: 'Employee',
    accent: 'orange',
    pages: [
      { key: 'dashboard', label: 'Overview', home: true },
      { key: 'profile', label: 'Profile' },
      { key: 'hours', label: 'My Hours' },
      { key: 'kpi', label: 'KPI Results' },
      { key: 'leaves', label: 'Leave' },
      { key: 'mesa', label: 'MESA' },
      { key: 'team', label: 'My Team' },
      { key: 'notifications', label: 'Notifications' },
      { key: 's-wall', label: 'S-Wall' },
    ],
  },
];

const DASHBOARD_BY_KEY: Record<DashboardKey, DashboardPages> = DASHBOARD_PAGES.reduce(
  (acc, d) => {
    acc[d.key] = d;
    return acc;
  },
  {} as Record<DashboardKey, DashboardPages>,
);

/** The editable page list for a dashboard (empty for unknown keys). */
export function dashboardPages(dash: DashboardKey): PageEntry[] {
  return DASHBOARD_BY_KEY[dash]?.pages ?? [];
}

/** The human label for a dashboard tab id (falls back to the id itself). */
export function pageLabel(dash: DashboardKey, key: string): string {
  return DASHBOARD_BY_KEY[dash]?.pages.find((p) => p.key === key)?.label ?? key;
}

const VALID: ReadonlySet<PageVisibility> = new Set(['visible', 'construction', 'hidden']);

/**
 * Parse the raw `app_settings.value` string into a config object. Defensive:
 * unknown shapes, bad JSON, or invalid states collapse to `{}` (= everything
 * visible) so a malformed row can never blank out a dashboard.
 */
export function parsePagesVisibility(raw: string | null | undefined): PagesVisibilityConfig {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: PagesVisibilityConfig = {};
  for (const dash of DASHBOARD_PAGES) {
    const sub = (parsed as Record<string, unknown>)[dash.key];
    if (!sub || typeof sub !== 'object' || Array.isArray(sub)) continue;
    const cleaned: Record<string, PageVisibility> = {};
    for (const [tabId, state] of Object.entries(sub as Record<string, unknown>)) {
      if (typeof state === 'string' && VALID.has(state as PageVisibility) && state !== 'visible') {
        cleaned[tabId] = state as PageVisibility;
      }
    }
    if (Object.keys(cleaned).length > 0) out[dash.key] = cleaned;
  }
  return out;
}

export function serializePagesVisibility(config: PagesVisibilityConfig): string {
  return JSON.stringify(config ?? {});
}

/** Resolve the visibility of one dashboard tab. Default (no entry) = visible. */
export function pageVisibility(
  config: PagesVisibilityConfig | null | undefined,
  dash: DashboardKey,
  key: string,
): PageVisibility {
  return config?.[dash]?.[key] ?? 'visible';
}

/**
 * Produce a new config with one tab's state set. Setting `visible` removes the
 * entry (so the stored JSON only ever records non-default overrides). Returns a
 * fresh object (does not mutate the input).
 */
export function withPageVisibility(
  config: PagesVisibilityConfig,
  dash: DashboardKey,
  key: string,
  state: PageVisibility,
): PagesVisibilityConfig {
  const next: PagesVisibilityConfig = { ...config };
  const sub = { ...(next[dash] ?? {}) };
  if (state === 'visible') {
    delete sub[key];
  } else {
    sub[key] = state;
  }
  if (Object.keys(sub).length > 0) next[dash] = sub;
  else delete next[dash];
  return next;
}
