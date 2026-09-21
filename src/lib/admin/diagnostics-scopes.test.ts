/**
 * Diagnostics service-map scopes.
 *
 * The properties pinned here are the ones that fail SILENTLY in production:
 *
 *  - A scope id matching no real node renders an empty map and logs nothing.
 *  - A node added to the route but not classified here is invisible on every
 *    scoped map, and the system map still looks right, so nobody notices.
 *  - A node missing from the component's mock builder is missing at first paint
 *    and pops in when the fetch lands (`buildUnknownBaseline` derives from it).
 *  - A scoped summary computed over ALL nodes reports failures the map does not
 *    draw — an HR map claiming a critical that is actually `pg-pool`.
 *  - An edge kept when only one endpoint is in scope points at a node that was
 *    never drawn.
 *
 * Run:  npx tsx --test src/lib/admin/diagnostics-scopes.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALL_DIAGNOSTIC_NODE_IDS,
  DIAGNOSTICS_TAB_GROUPS,
  SERVICE_MAP_SCOPES,
  countsByStatus,
  filterAlertsToScope,
  filterEdgesToScope,
  filterNodesToScope,
  overallStatusOf,
  type MapStatus,
} from '@/lib/admin/diagnostics-scopes';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

/**
 * Pull the node ids out of a `const nodes: DiagnosticNode[] = [ … ];` block.
 * Both the route and the component's mock builder declare that exact shape, and
 * both spell a node either as the `node(id, …)` helper or as an inline object
 * literal with an `id:` field.
 *
 * Scoped to the block rather than the whole file on purpose: both files carry
 * unrelated `'…'` string unions and `id:` keys elsewhere, and a whole-file
 * regex would quietly pick them up and make this test pass for the wrong reason.
 */
function nodeIdsDeclaredIn(rel: string): string[] {
  const src = read(rel);
  const start = src.indexOf('const nodes: DiagnosticNode[] = [');
  assert.ok(start >= 0, `${rel} no longer declares "const nodes: DiagnosticNode[] = [" — this scan is blind, fix it`);
  const end = src.indexOf('\n  ];', start);
  assert.ok(end > start, `${rel}: could not find the end of the nodes array`);
  const block = src.slice(start, end);

  const ids = new Set<string>();
  for (const m of block.matchAll(/\bnode\('([a-z0-9-]+)'/g)) ids.add(m[1]);
  for (const m of block.matchAll(/^\s{6}id: '([a-z0-9-]+)',$/gm)) ids.add(m[1]);
  return [...ids];
}

const node = (id: string, status: MapStatus) => ({ id, status });

test('every scope is a subset of the canonical node list', () => {
  const canonical = new Set<string>(ALL_DIAGNOSTIC_NODE_IDS);
  for (const scope of Object.values(SERVICE_MAP_SCOPES)) {
    if (!scope.nodeIds) continue;
    for (const id of scope.nodeIds) {
      // A typo here is not an error at runtime — it is one missing card.
      assert.ok(canonical.has(id), `scope "${scope.id}" lists unknown node id "${id}"`);
    }
  }
});

test('the canonical list is exactly what the route emits', () => {
  const fromRoute = nodeIdsDeclaredIn('app/api/admin/diagnostics/route.ts').sort();
  assert.deepEqual(
    fromRoute,
    [...ALL_DIAGNOSTIC_NODE_IDS].sort(),
    'the diagnostics route and ALL_DIAGNOSTIC_NODE_IDS disagree — a node added to one must be classified in the other, or it is invisible on every scoped map',
  );
});

test('the component mock covers every node the route emits', () => {
  // buildUnknownBaseline() derives from buildMockDiagnostics(), and that is what
  // paints before the first fetch and after a failed one. A node missing there
  // makes a scoped map render short a card, then pop.
  const fromMock = nodeIdsDeclaredIn('src/components/SystemDiagnostics.tsx').sort();
  assert.deepEqual(
    fromMock,
    [...ALL_DIAGNOSTIC_NODE_IDS].sort(),
    'buildMockDiagnostics is missing (or has an extra) node versus the route — first paint and the probe-failure baseline would not match the live map',
  );
});

test('the system scope is not a hand-maintained list', () => {
  // If it ever becomes one, a node added to the route silently disappears from
  // the one map that promises to show everything. Kane, 2026-09-18: "Admin
  // should bypass everything and should monitor everything."
  assert.equal(SERVICE_MAP_SCOPES.system.nodeIds, null);
});

test('the scoped maps actually scope, and are not empty', () => {
  for (const id of ['hr', 'accounting'] as const) {
    const ids = SERVICE_MAP_SCOPES[id].nodeIds;
    assert.ok(ids && ids.length > 0, `scope "${id}" draws nothing`);
    assert.ok(
      ids.length < ALL_DIAGNOSTIC_NODE_IDS.length,
      `scope "${id}" draws every node — it is the system map with extra steps`,
    );
  }
});

test('the HR scope separates listed from staged', () => {
  // 1,479 listed vs 1,049 staged live. Collapsing them hides the largest single
  // loss in the funnel, which is the reason this map exists.
  const ids = SERVICE_MAP_SCOPES.hr.nodeIds ?? [];
  assert.ok(ids.includes('new-hire-checklist'));
  assert.ok(ids.includes('hr-onboarding'));
});

test('the Accounting scope holds the money path and excludes the side surfaces', () => {
  const ids = new Set<string>(SERVICE_MAP_SCOPES.accounting.nodeIds ?? []);
  for (const required of [
    'hubstaff-csv',
    'payroll-wizard',
    'disbursement-records',
    'payment-dispatch',
    'cycle-closeout',
  ]) {
    assert.ok(ids.has(required), `the money path is missing "${required}"`);
  }
  for (const excluded of ['payroll-notes', 'time-adjust', 'tickets', 'rate-history']) {
    assert.ok(
      !ids.has(excluded),
      `"${excluded}" is a side surface — a stall there does not mean money stopped moving (Kane: "core stuff")`,
    );
  }
});

test('each scope persists its layout under its own key', () => {
  const keys = Object.values(SERVICE_MAP_SCOPES).map((s) => s.storageKey);
  assert.equal(new Set(keys).size, keys.length, 'two scopes share a positions key — dragging one map would rewrite another');
});

test('the system map keeps the key its drag positions already live under', () => {
  // Changing this silently resets every admin's saved layout.
  assert.equal(SERVICE_MAP_SCOPES.system.storageKey, 'system-diagnostics-positions-v2');
});

test('tab ids are unique and the three map tabs are distinguishable to a screen reader', () => {
  const tabs = DIAGNOSTICS_TAB_GROUPS.flatMap((g) => g.tabs);
  const ids = tabs.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate Diagnostics tab id');

  const mapTabs = tabs.filter((t) => t.label === 'Service Map');
  assert.equal(mapTabs.length, 3, 'expected one Service Map tab per dashboard group');
  const labels = mapTabs.map((t) => t.ariaLabel);
  assert.equal(
    new Set(labels).size,
    labels.length,
    'three tabs read "Service Map" — the aria-labels are the only thing telling them apart',
  );
});

test('the tabs that shipped 2026-09-04 keep their ids', () => {
  // `diagnostics-performance-tabs.md` names these; renaming desyncs the doc.
  const ids = DIAGNOSTICS_TAB_GROUPS.flatMap((g) => g.tabs).map((t) => t.id);
  for (const shipped of ['map', 'hr', 'cycles']) assert.ok(ids.includes(shipped));
});

test('tabs are grouped by dashboard, one group per dashboard', () => {
  const groups = DIAGNOSTICS_TAB_GROUPS.map((g) => g.dashboard);
  assert.deepEqual(groups, ['System', 'HR', 'Accounting']);
  assert.equal(new Set(groups).size, groups.length, 'a dashboard appears twice — the grouping is the point');
});

test('overallStatusOf: worst wins, and healthy needs unanimity', () => {
  assert.equal(overallStatusOf([node('a', 'healthy'), node('b', 'healthy')]), 'healthy');
  assert.equal(overallStatusOf([node('a', 'healthy'), node('b', 'warning')]), 'warning');
  assert.equal(overallStatusOf([node('a', 'warning'), node('b', 'critical')]), 'critical');
  // An unreadable probe next to a burning one does not soften the verdict.
  assert.equal(overallStatusOf([node('a', 'unknown'), node('b', 'critical')]), 'critical');
  // But "we could not read it" must never render as "it is fine".
  assert.equal(overallStatusOf([node('a', 'healthy'), node('b', 'unknown')]), 'unknown');
  assert.equal(overallStatusOf([]), 'unknown');
});

test('a scoped verdict ignores failures the map does not draw', () => {
  const nodes = [node('master-list', 'healthy'), node('pg-pool', 'critical')];
  const hr = filterNodesToScope(nodes, SERVICE_MAP_SCOPES.hr.nodeIds);
  // pg-pool is not on the HR map, so the HR map does not get to call itself critical.
  assert.equal(overallStatusOf(hr), 'healthy');
  assert.equal(overallStatusOf(nodes), 'critical');
});

test('countsByStatus accounts for every node exactly once', () => {
  const nodes = [
    node('a', 'healthy'),
    node('b', 'healthy'),
    node('c', 'warning'),
    node('d', 'critical'),
    node('e', 'unknown'),
  ];
  const counts = countsByStatus(nodes);
  assert.deepEqual(counts, { healthy: 2, warning: 1, critical: 1, unknown: 1 });
  assert.equal(
    counts.healthy + counts.warning + counts.critical + counts.unknown,
    nodes.length,
  );
});

test('filterNodesToScope hands the system map its array back untouched', () => {
  const nodes = [node('a', 'healthy')];
  assert.equal(filterNodesToScope(nodes, null), nodes);
});

test('filterEdgesToScope needs BOTH endpoints in scope', () => {
  const edges = [
    { source: 'hr-onboarding', target: 'master-list' },   // both in HR
    { source: 'hr-onboarding', target: 'supabase-client' }, // target is not
    { source: 'payroll-wizard', target: 'master-list' },   // source is not
  ];
  const kept = filterEdgesToScope(edges, SERVICE_MAP_SCOPES.hr.nodeIds);
  assert.deepEqual(kept, [{ source: 'hr-onboarding', target: 'master-list' }]);
});

test('filterEdgesToScope leaves the system map alone', () => {
  const edges = [{ source: 'a', target: 'b' }];
  assert.equal(filterEdgesToScope(edges, null), edges);
});

test('filterAlertsToScope keeps only this map’s news', () => {
  const alerts = [
    { id: 'alert-pg-pool', nodeId: 'pg-pool' },
    { id: 'alert-master-list', nodeId: 'master-list' },
  ];
  const kept = filterAlertsToScope(alerts, SERVICE_MAP_SCOPES.hr.nodeIds);
  assert.deepEqual(kept.map((a) => a.nodeId), ['master-list']);
  assert.equal(filterAlertsToScope(alerts, null), alerts);
});
