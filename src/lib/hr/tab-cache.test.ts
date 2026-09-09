import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FRESH_WINDOW_MS,
  HR_TAB_CACHE_KEYS,
  __resetHrTabCache,
  clearHrTabCache,
  getHrTabCache,
  hasHrTabCache,
  isHrTabCacheFresh,
  readHrTabCacheStamp,
  setHrTabCache,
} from './tab-cache';

/**
 * The HR store suppressed every tab's mount fetch whenever an entry was warm,
 * and justified that in its own docstring with "each tab's existing Realtime
 * subscription". Ten of its twelve datasets have no subscription at all, and
 * browser `postgres_changes` is documented dead for this project
 * (`memory/supabase-realtime-anon-rls-dead`), so an HR session left open never
 * re-pulled the global master list, the offboarding queue or the screening
 * board on a tab return.
 *
 * These tests pin the split that fixed it: `hasHrTabCache` = "is there
 * something to PAINT", `isHrTabCacheFresh` = "may the fetch be SKIPPED".
 * Collapsing the two back into one predicate is the regression.
 */

const GML = HR_TAB_CACHE_KEYS.globalMasterList;
const QUEUE = HR_TAB_CACHE_KEYS.offboardQueue;

test('a warm entry paints and, while fresh, suppresses the fetch', () => {
  __resetHrTabCache();
  setHrTabCache(GML, [{ name: 'A' }]);
  assert.ok(hasHrTabCache(GML), 'there is something to paint');
  assert.ok(isHrTabCacheFresh(GML), 'and it is young enough to skip the fetch');
  assert.deepEqual(getHrTabCache(GML), [{ name: 'A' }]);
});

test('past the window the entry STILL paints but no longer suppresses the fetch', () => {
  // This is the whole fix: the row stays on screen (no skeleton flash) and the
  // consumer revalidates behind it.
  __resetHrTabCache();
  setHrTabCache(GML, [{ name: 'A' }]);
  const later = Date.now() + FRESH_WINDOW_MS + 1;

  assert.equal(isHrTabCacheFresh(GML, later), false, 'stale → the caller must fetch');
  assert.ok(hasHrTabCache(GML), 'but the value is still there to paint');
  assert.deepEqual(getHrTabCache(GML), [{ name: 'A' }]);
});

test('exactly at the window boundary the entry is stale', () => {
  __resetHrTabCache();
  setHrTabCache(GML, [1]);
  const stamp = readHrTabCacheStamp(GML)!;
  assert.equal(isHrTabCacheFresh(GML, stamp + FRESH_WINDOW_MS), false);
  assert.ok(isHrTabCacheFresh(GML, stamp + FRESH_WINDOW_MS - 1));
});

test('a miss is neither paintable nor fresh', () => {
  __resetHrTabCache();
  assert.equal(hasHrTabCache(GML), false);
  assert.equal(isHrTabCacheFresh(GML), false);
  assert.equal(getHrTabCache(GML), undefined);
});

test('re-writing a key restamps it, so a refresh re-opens the window', () => {
  __resetHrTabCache();
  setHrTabCache(GML, [1]);
  const first = readHrTabCacheStamp(GML)!;
  const later = first + FRESH_WINDOW_MS + 1;
  assert.equal(isHrTabCacheFresh(GML, later), false);

  setHrTabCache(GML, [2]); // a Refresh / revalidate writing back
  assert.ok(isHrTabCacheFresh(GML), 'the fresh window restarts from the new write');
  assert.deepEqual(getHrTabCache(GML), [2]);
});

test('null and [] are cached values, not misses', () => {
  __resetHrTabCache();
  setHrTabCache(GML, null);
  assert.equal(getHrTabCache(GML), null);
  assert.ok(hasHrTabCache(GML));

  setHrTabCache(QUEUE, []);
  assert.deepEqual(getHrTabCache(QUEUE), []);
  assert.ok(hasHrTabCache(QUEUE));
});

test('clearing one key leaves the others alone', () => {
  __resetHrTabCache();
  setHrTabCache(GML, [1]);
  setHrTabCache(QUEUE, [2]);

  clearHrTabCache(GML);

  assert.equal(hasHrTabCache(GML), false);
  assert.deepEqual(getHrTabCache(QUEUE), [2]);
});

test('the store is never persisted — no identity envelope means no storage', async () => {
  // This store has no identity stamp, which is only safe because it cannot
  // outlive the page. Mirroring it to sessionStorage without adding the
  // envelope `accounting/tab-cache.ts` has would leak one HR user's roster to
  // the next person on that browser tab.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./tab-cache.ts', import.meta.url), 'utf8');
  const code = src
    .replace(/\/\*\*[\s\S]*?\*\//g, '') // strip block comments
    .replace(/^\s*\/\/.*$/gm, ''); // strip line comments
  assert.ok(
    !/sessionStorage|localStorage/.test(code),
    'persisting this store requires the identity envelope first',
  );
});

test('the fresh window matches the documented Payroll Notes precedent', () => {
  assert.equal(FRESH_WINDOW_MS, 30_000);
});

test('every key is uniquely spelled', () => {
  const all = Object.values(HR_TAB_CACHE_KEYS);
  assert.equal(new Set(all).size, all.length, `duplicate cache key: ${all.join(', ')}`);
});
