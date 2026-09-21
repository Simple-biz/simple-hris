/**
 * Diagnostics service-map scopes — which nodes each map shows, and the status
 * maths over that subset.
 *
 * Admin → Diagnostics renders the SAME probe response three ways: the whole
 * stack, the HR hire path, and the Accounting money path. This module is the one
 * place that says which node belongs to which map, so the tab strip, the node
 * filter, the edge filter and the summary counts cannot disagree about what a
 * map contains.
 *
 * Two properties are load-bearing and both are tested:
 *
 *  - **A scope id that is not a real node renders an EMPTY map with no error.**
 *    React Flow is given a filtered list; an id nothing matches is simply
 *    absent. So `ALL_DIAGNOSTIC_NODE_IDS` is the canonical list, every scope is
 *    asserted to be a subset of it, and a source scan proves that list still
 *    equals what the route actually emits.
 *  - **A scoped map's summary describes its OWN scope.** The HR map must never
 *    report a `pg-pool` critical it does not draw. `overallStatusOf` and
 *    `countsByStatus` therefore take the scoped nodes, and this is the single
 *    implementation of that precedence — the route and the mock builder each
 *    carried their own copy before.
 *
 * Deliberately import-free: the test needs no env vars, no Supabase client and
 * no React. Layout templates are NOT here — they live with the component that
 * renders them, next to the existing `NODE_POSITIONS`, so layout has one home.
 */

/** Mirrors the component's `DiagnosticStatus` and the probes' `ProbeStatus`
 *  structurally, without importing either (one drags React, the other drags the
 *  Supabase client into the test process). */
export type MapStatus = 'healthy' | 'warning' | 'critical' | 'unknown';

export type ServiceMapScopeId = 'system' | 'hr' | 'accounting';

/** The dashboard a Diagnostics tab belongs to. Kane, 2026-09-18: *"Group them by
 *  Dashboards"* — the strip groups by this, it is not cosmetic ordering. */
export type DiagnosticsDashboard = 'System' | 'HR' | 'Accounting';

/** Every node id the diagnostics route emits. Pinned against the route itself by
 *  a source scan in the test — add a node there and this fails until it is
 *  classified here, which is the point: an unclassified node is invisible to
 *  every scoped map and nobody would notice. */
export const ALL_DIAGNOSTIC_NODE_IDS = [
  'admin-shell',
  'payroll-wizard',
  'rates',
  'hubstaff-csv',
  'master-list',
  'roster-drift',
  'supabase-client',
  'supabase-postgres',
  'pg-pool',
  'daily-report',
  'auth-login',
  'audit-log',
  'disbursement-records',
  'app-settings',
  'google-sheet-sync',
  'rate-history',
  'new-hire-checklist',
  'hr-onboarding',
  'hr-offboarding',
  'tickets',
  'time-adjust',
  'payroll-notes',
  'mesa',
  'payment-dispatch',
  'cycle-closeout',
] as const;

export type DiagnosticNodeId = (typeof ALL_DIAGNOSTIC_NODE_IDS)[number];

/**
 * The HR hire path: listed → staged → on the roster, plus the two teardown
 * routes off it.
 *
 * `new-hire-checklist` is the intake grid (what HR lists, and the Lock-in that
 * fires the orientation email); `hr-onboarding` is the staging table the listed
 * hire has to reach. Those are different populations — 1,479 listed vs 1,049
 * staged live — and the gap between them is the largest single loss in the
 * funnel (`diagnostics-performance-tabs.md:453-457`). A map that collapsed them
 * into one node would hide exactly the thing it exists to show.
 */
const HR_NODE_IDS = [
  'new-hire-checklist',
  'hr-onboarding',
  'hr-offboarding',
  'master-list',
  'roster-drift',
  'google-sheet-sync',
] as const satisfies readonly DiagnosticNodeId[];

/**
 * The Accounting money path — hours in, money out, week declared (Kane,
 * 2026-09-18: *"Core stuff like if everything is working fine"*, then *"Yeah
 * go"* to this set).
 *
 * Deliberately EXCLUDED, and they stay on the system map where an admin sees
 * everything: `payroll-notes`, `time-adjust`, `tickets`, `rate-history`. They
 * are side surfaces — a stalled one does not mean money stopped moving, and
 * putting them here would make "is the money path healthy?" unanswerable at a
 * glance, which is the only question this map is for.
 */
const ACCOUNTING_NODE_IDS = [
  'rates',
  'hubstaff-csv',
  'payroll-wizard',
  'disbursement-records',
  'payment-dispatch',
  'cycle-closeout',
  'mesa',
] as const satisfies readonly DiagnosticNodeId[];

export type ServiceMapScope = {
  id: ServiceMapScopeId;
  /** Group heading in the tab strip. */
  dashboard: DiagnosticsDashboard;
  /** Visible tab label. Three scopes share "Service Map" — the group above it
   *  carries the difference visually, `ariaLabel` carries it for screen
   *  readers, which is why both exist. */
  tabLabel: string;
  ariaLabel: string;
  /** Header shown above the map itself. */
  title: string;
  blurb: string;
  /** `null` means every node in the response — the system map must never be a
   *  hand-maintained list, or a node added to the route would vanish from the
   *  one map that promises to show everything. */
  nodeIds: readonly DiagnosticNodeId[] | null;
  /** Per-scope drag persistence. Sharing one key would make dragging the HR map
   *  rewrite the system map's saved layout. */
  storageKey: string;
};

export const SERVICE_MAP_SCOPES: Record<ServiceMapScopeId, ServiceMapScope> = {
  system: {
    id: 'system',
    dashboard: 'System',
    tabLabel: 'Service Map',
    ariaLabel: 'System service map',
    title: 'System Diagnostics',
    blurb: 'Admin-only health map for payroll, data, database, and security signals.',
    nodeIds: null,
    storageKey: 'system-diagnostics-positions-v2',
  },
  hr: {
    id: 'hr',
    dashboard: 'HR',
    tabLabel: 'Service Map',
    ariaLabel: 'HR service map',
    title: 'HR Pipeline — Service Map',
    blurb:
      'The hire path: what HR listed, what reached staging, what reached the roster, and the two teardown routes off it.',
    nodeIds: HR_NODE_IDS,
    storageKey: 'system-diagnostics-positions-hr-v1',
  },
  accounting: {
    id: 'accounting',
    dashboard: 'Accounting',
    tabLabel: 'Service Map',
    ariaLabel: 'Accounting service map',
    title: 'Accounting — Service Map',
    blurb: 'The money path: hours in, pay staged, money dispatched, the week declared closed.',
    nodeIds: ACCOUNTING_NODE_IDS,
    storageKey: 'system-diagnostics-positions-accounting-v1',
  },
};

/** Tab-strip order. The two performance tabs that shipped 2026-09-04 keep their
 *  ids AND their labels — renaming a shipped tab would desync
 *  `diagnostics-performance-tabs.md`, which names them. */
export const DIAGNOSTICS_TAB_GROUPS: ReadonlyArray<{
  dashboard: DiagnosticsDashboard;
  tabs: ReadonlyArray<{ id: string; label: string; ariaLabel: string; hint: string }>;
}> = [
  {
    dashboard: 'System',
    tabs: [
      {
        id: 'map',
        label: 'Service Map',
        ariaLabel: 'System service map',
        hint: 'Live health of the whole stack',
      },
    ],
  },
  {
    dashboard: 'HR',
    tabs: [
      {
        id: 'hr-map',
        label: 'Service Map',
        ariaLabel: 'HR service map',
        hint: 'HR — live health of the hire path',
      },
      {
        id: 'hr',
        label: 'HR Pipeline',
        ariaLabel: 'HR pipeline performance',
        hint: 'HR — hires that reached the master list',
      },
    ],
  },
  {
    dashboard: 'Accounting',
    tabs: [
      {
        id: 'acct-map',
        label: 'Service Map',
        ariaLabel: 'Accounting service map',
        hint: 'Accounting — live health of the money path',
      },
      {
        id: 'cycles',
        label: 'Payroll Cycles',
        ariaLabel: 'Payroll cycle performance',
        hint: 'Accounting — pay cycle success rate',
      },
    ],
  },
];

/* ────────────────── Filtering ────────────────── */

type NodeLike = { id: string };
type EdgeLike = { source: string; target: string };

/** The nodes a scope draws, in the response's own order. A `null` scope (system)
 *  returns the array unchanged — same reference, so React memoisation upstream
 *  is not defeated for the map that shows everything. */
export function filterNodesToScope<T extends NodeLike>(
  nodes: readonly T[],
  nodeIds: readonly string[] | null,
): readonly T[] {
  if (!nodeIds) return nodes;
  const allowed = new Set<string>(nodeIds);
  return nodes.filter((n) => allowed.has(n.id));
}

/** Edges whose BOTH endpoints are in scope. An edge kept because only its source
 *  survived would point at a node the map never drew — React Flow drops it
 *  silently and the map quietly loses a relationship, so both ends are checked
 *  here rather than left to the renderer. */
export function filterEdgesToScope<T extends EdgeLike>(
  edges: readonly T[],
  nodeIds: readonly string[] | null,
): readonly T[] {
  if (!nodeIds) return edges;
  const allowed = new Set<string>(nodeIds);
  return edges.filter((e) => allowed.has(e.source) && allowed.has(e.target));
}

/** Alerts belonging to the nodes a scope draws. An alert for an off-map node is
 *  not this map's news; the system map still shows every one of them. */
export function filterAlertsToScope<T extends { nodeId: string }>(
  alerts: readonly T[],
  nodeIds: readonly string[] | null,
): readonly T[] {
  if (!nodeIds) return alerts;
  const allowed = new Set<string>(nodeIds);
  return alerts.filter((a) => allowed.has(a.nodeId));
}

/* ────────────────── Status maths over a scope ────────────────── */

/**
 * Worst-wins, with `healthy` requiring unanimity — the same precedence the route
 * applies to the whole node set, applied to whatever subset it is handed.
 *
 * `unknown` deliberately does NOT beat `warning`/`critical`: a map where one
 * probe could not be read and another is on fire is on fire. But a map with a
 * single unknown and no failures is `unknown`, never `healthy` — "we could not
 * read it" must not render as "it is fine". An empty node set is `unknown` for
 * the same reason.
 */
export function overallStatusOf(nodes: readonly { status: MapStatus }[]): MapStatus {
  if (nodes.length === 0) return 'unknown';
  if (nodes.some((n) => n.status === 'critical')) return 'critical';
  if (nodes.some((n) => n.status === 'warning')) return 'warning';
  return nodes.every((n) => n.status === 'healthy') ? 'healthy' : 'unknown';
}

export function countsByStatus(
  nodes: readonly { status: MapStatus }[],
): Record<MapStatus, number> {
  const counts: Record<MapStatus, number> = { healthy: 0, warning: 0, critical: 0, unknown: 0 };
  for (const n of nodes) counts[n.status] += 1;
  return counts;
}
