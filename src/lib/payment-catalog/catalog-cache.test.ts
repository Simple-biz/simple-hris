import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CATALOG_TAB_IDS,
  DEFAULT_CATALOG_TAB,
  parseCachedCatalog,
  parseCachedFx,
  parseCachedTab,
} from './catalog-cache';

// The Accounting tab cache's envelope guarantees identity, schema version and
// age. It does NOT guarantee the shape inside, so these are the rules that stand
// between a stale or hand-edited blob and the rate source of truth.

test('a non-object blob is a miss, never a partial catalog', () => {
  for (const raw of [null, undefined, 'catalog', 42, [], true]) {
    assert.equal(parseCachedCatalog(raw), null, `expected a miss for ${JSON.stringify(raw)}`);
  }
});

test('a missing or non-array list degrades to empty, never to a guess', () => {
  const parsed = parseCachedCatalog({ bonuses: 'not-a-list', payStructures: null });
  assert.ok(parsed);
  assert.deepEqual(parsed.bonuses, []);
  assert.deepEqual(parsed.payStructures, []);
  assert.deepEqual(parsed.banks, []);
});

test('a valid slice still seeds when a sibling slice is junk', () => {
  // The same rule the live commits follow: a read that did not land leaves its
  // slice alone rather than blanking the whole catalog.
  const parsed = parseCachedCatalog({
    bonuses: [{ id: 'b1' }],
    payStructures: 'junk',
  });
  assert.ok(parsed);
  assert.equal(parsed.bonuses.length, 1);
  assert.deepEqual(parsed.payStructures, []);
});

// --- the CAS pairing rules -------------------------------------------------
//
// A revision is the compare-and-swap token the Edit Department dialog hands back
// to earn its 409. Separated from the rows it describes, it stops being a guard
// and becomes the mechanism by which a save silently clobbers a teammate's edit.

test('the registry revision is DROPPED when the registry itself is not usable', () => {
  const parsed = parseCachedCatalog({
    deptRegistry: 'gone',
    deptRegistryRevision: 'rev-7',
  });
  assert.ok(parsed);
  assert.deepEqual(parsed.deptRegistry, []);
  assert.equal(
    parsed.deptRegistryRevision,
    null,
    'a CAS token outliving its rows is how a stale save clobbers a teammate',
  );
});

test('the registry revision survives only beside a real registry', () => {
  const parsed = parseCachedCatalog({
    deptRegistry: [{ key: 'lead_gen', name: 'Lead Gen', subDepartments: [] }],
    deptRegistryRevision: 'rev-7',
  });
  assert.ok(parsed);
  assert.equal(parsed.deptRegistryRevision, 'rev-7');
});

test('a non-string registry revision is refused', () => {
  const parsed = parseCachedCatalog({ deptRegistry: [], deptRegistryRevision: 7 });
  assert.ok(parsed);
  assert.equal(parsed.deptRegistryRevision, null);
});

test('the builtin-subs revision is DROPPED when the sub map is not usable', () => {
  const parsed = parseCachedCatalog({
    builtinSubs: ['not', 'a', 'map'],
    builtinSubsRevision: 'rev-3',
  });
  assert.ok(parsed);
  assert.deepEqual(parsed.builtinSubs, {});
  assert.equal(parsed.builtinSubsRevision, null);
});

test('the builtin-subs revision survives only beside a real sub map', () => {
  const parsed = parseCachedCatalog({
    builtinSubs: { 'lead_gen:closers': { key: 'closers', name: 'Closers' } },
    builtinSubsRevision: 'rev-3',
  });
  assert.ok(parsed);
  assert.equal(parsed.builtinSubsRevision, 'rev-3');
});

test('an array is not a map — deptManagers and builtinSubs refuse one', () => {
  // `typeof [] === 'object'`, so the array check is load-bearing: an array here
  // would spread into the registry resolvers as index-keyed nonsense.
  const parsed = parseCachedCatalog({ deptManagers: [], builtinSubs: [] });
  assert.ok(parsed);
  assert.deepEqual(parsed.deptManagers, {});
  assert.deepEqual(parsed.builtinSubs, {});
});

// --- the view selection ----------------------------------------------------

test('a cached tab id is validated against the list the strip actually renders', () => {
  for (const id of CATALOG_TAB_IDS) {
    assert.equal(parseCachedTab({ tab: id }), id);
  }
});

test('a tab id no longer on the strip falls back to the default', () => {
  // A tab removed by a future deploy must not come back out of a still-open tab
  // as an unrenderable selection.
  for (const raw of [{ tab: 'retired-tab' }, { tab: 7 }, {}, null, 'overview']) {
    assert.equal(parseCachedTab(raw), DEFAULT_CATALOG_TAB);
  }
});

// --- FX --------------------------------------------------------------------

test('FX needs both legs finite and positive', () => {
  assert.deepEqual(parseCachedFx({ usdToPhp: 58.5, usdToCop: 4100 }), {
    usdToPhp: 58.5,
    usdToCop: 4100,
  });
});

test('a zero, negative, NaN or missing FX leg keeps the official fallback', () => {
  for (const raw of [
    { usdToPhp: 0, usdToCop: 4100 },
    { usdToPhp: 58.5, usdToCop: 0 },
    { usdToPhp: -58.5, usdToCop: 4100 },
    { usdToPhp: Number.NaN, usdToCop: 4100 },
    { usdToPhp: Infinity, usdToCop: 4100 },
    { usdToPhp: '58.5', usdToCop: 4100 },
    { usdToPhp: 58.5 },
    null,
  ]) {
    assert.equal(parseCachedFx(raw), null, `expected a miss for ${JSON.stringify(raw)}`);
  }
});

// --- the boundary ----------------------------------------------------------

test('the catalog cache never reaches for the skip flag', async () => {
  // The Payment Catalog is the rate source of truth, which is the banned
  // category in `accounting-dashboard-cache.md` § *The skip-flag policy*: the
  // seed exists to PAINT, and the mount refetch must always run. This module is
  // the seam a future change would most plausibly add one to.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./catalog-cache.ts', import.meta.url), 'utf8');
  assert.ok(
    !/\bhasFetchedThisSession\b|\bmarkFetchedThisSession\b/.test(
      src.replace(/`hasFetchedThisSession`/g, ''),
    ),
    'the catalog seed may never gate its refetch — it is a per-person pay figure',
  );
});
