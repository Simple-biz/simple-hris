/**
 * The Orphanage tab cache.
 *
 * Two properties carry it, and both are things that have gone wrong before in
 * this codebase:
 *
 *  1. PAINT and SKIP are different questions. Collapsing them into one predicate
 *     is exactly the HR-store bug of 2026-09-09 — a session left open all day
 *     never re-pulled anything because a warm entry suppressed every fetch.
 *  2. Nothing reaches browser storage. This store has no identity stamp, which
 *     is only safe because it dies with the page; a stamp-less mirror would leak
 *     one user's roster and gift backlog to the next person on that browser tab.
 *
 * Run:  npx tsx --test src/lib/orphanage/tab-cache.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  FRESH_WINDOW_MS,
  ORPHANAGE_TAB_CACHE_KEYS,
  __resetOrphanageTabCache,
  clearOrphanageTabCache,
  clearOrphanageTabCachePrefix,
  getOrphanageTabCache,
  hasOrphanageTabCache,
  isOrphanageTabCacheFresh,
  readOrphanageTabCacheStamp,
  setOrphanageTabCache,
} from './tab-cache';

const K = ORPHANAGE_TAB_CACHE_KEYS.giftReceipts;

// ── PAINT vs SKIP ────────────────────────────────────────────────────────────

test('a miss paints nothing and skips nothing', () => {
  __resetOrphanageTabCache();
  assert.equal(hasOrphanageTabCache(K), false);
  assert.equal(isOrphanageTabCacheFresh(K), false);
  assert.equal(getOrphanageTabCache(K), undefined);
});

test('a fresh entry both paints and permits the skip', () => {
  __resetOrphanageTabCache();
  setOrphanageTabCache(K, [{ received: true }]);
  assert.equal(hasOrphanageTabCache(K), true);
  assert.equal(isOrphanageTabCacheFresh(K), true);
});

test('a STALE entry still PAINTS but no longer permits the skip', () => {
  // The whole point. A stale entry that stopped painting would flash a skeleton
  // on every tab return; one that kept skipping would never refresh at all.
  __resetOrphanageTabCache();
  const stamp = Date.now();
  setOrphanageTabCache(K, ['rows']);
  const later = stamp + FRESH_WINDOW_MS + 1;
  assert.equal(hasOrphanageTabCache(K), true, 'must still paint');
  assert.equal(isOrphanageTabCacheFresh(K, later), false, 'must no longer skip');
  assert.deepEqual(getOrphanageTabCache(K), ['rows']);
});

test('the boundary is exclusive — exactly FRESH_WINDOW_MS old is already stale', () => {
  __resetOrphanageTabCache();
  const now = Date.now();
  setOrphanageTabCache(K, 1);
  const stamp = readOrphanageTabCacheStamp(K)!;
  assert.equal(isOrphanageTabCacheFresh(K, stamp + FRESH_WINDOW_MS - 1), true);
  assert.equal(isOrphanageTabCacheFresh(K, stamp + FRESH_WINDOW_MS), false);
  assert.ok(stamp >= now);
});

test('a re-write restamps, re-opening the window', () => {
  __resetOrphanageTabCache();
  setOrphanageTabCache(K, 'first');
  const first = readOrphanageTabCacheStamp(K)!;
  setOrphanageTabCache(K, 'second');
  const second = readOrphanageTabCacheStamp(K)!;
  assert.ok(second >= first);
  assert.equal(getOrphanageTabCache(K), 'second');
  assert.equal(isOrphanageTabCacheFresh(K, second + 1), true);
});

// ── Falsy and empty values are real values ───────────────────────────────────

test('an empty array is a cached VALUE, not a miss', () => {
  // "No gifts owed" is an answer. Treating it as a miss would refetch forever
  // and flash a skeleton on the very view that is correctly empty.
  __resetOrphanageTabCache();
  setOrphanageTabCache(K, []);
  assert.equal(hasOrphanageTabCache(K), true);
  assert.deepEqual(getOrphanageTabCache(K), []);
});

test('null and 0 are cached values too', () => {
  __resetOrphanageTabCache();
  setOrphanageTabCache(K, null);
  assert.equal(hasOrphanageTabCache(K), true);
  assert.equal(getOrphanageTabCache(K), null);
  setOrphanageTabCache(K, 0);
  assert.equal(getOrphanageTabCache(K), 0);
});

// ── Invalidation after a write ───────────────────────────────────────────────

test('clearing one key leaves its siblings alone', () => {
  __resetOrphanageTabCache();
  setOrphanageTabCache(ORPHANAGE_TAB_CACHE_KEYS.giftReceipts, 'r');
  setOrphanageTabCache(ORPHANAGE_TAB_CACHE_KEYS.giftNotes, 'n');
  clearOrphanageTabCache(ORPHANAGE_TAB_CACHE_KEYS.giftReceipts);
  assert.equal(hasOrphanageTabCache(ORPHANAGE_TAB_CACHE_KEYS.giftReceipts), false);
  assert.equal(hasOrphanageTabCache(ORPHANAGE_TAB_CACHE_KEYS.giftNotes), true);
});

test('the prefix clear drops every gift dataset after a write', () => {
  // Recording a gift as received and then being shown the pre-write value is
  // worse than a slow tab, so a mutation invalidates the whole surface.
  __resetOrphanageTabCache();
  setOrphanageTabCache(ORPHANAGE_TAB_CACHE_KEYS.giftEmployees, 'e');
  setOrphanageTabCache(ORPHANAGE_TAB_CACHE_KEYS.giftNotes, 'n');
  setOrphanageTabCache(ORPHANAGE_TAB_CACHE_KEYS.giftShipping, 's');
  setOrphanageTabCache(ORPHANAGE_TAB_CACHE_KEYS.giftReceipts, 'r');
  setOrphanageTabCache('orph:other:thing', 'keep');

  clearOrphanageTabCachePrefix(ORPHANAGE_TAB_CACHE_KEYS.giftPrefix);

  assert.equal(hasOrphanageTabCache(ORPHANAGE_TAB_CACHE_KEYS.giftEmployees), false);
  assert.equal(hasOrphanageTabCache(ORPHANAGE_TAB_CACHE_KEYS.giftNotes), false);
  assert.equal(hasOrphanageTabCache(ORPHANAGE_TAB_CACHE_KEYS.giftShipping), false);
  assert.equal(hasOrphanageTabCache(ORPHANAGE_TAB_CACHE_KEYS.giftReceipts), false);
  assert.equal(hasOrphanageTabCache('orph:other:thing'), true, 'unrelated keys survive');
});

test('every gift key sits under the prefix the invalidator uses', () => {
  // A key that misses the prefix would silently survive every write.
  const { giftPrefix, ...datasets } = ORPHANAGE_TAB_CACHE_KEYS;
  for (const [name, key] of Object.entries(datasets)) {
    assert.ok(key.startsWith(giftPrefix), `${name} (${key}) must start with ${giftPrefix}`);
  }
});

// ── The storage prohibition, enforced ────────────────────────────────────────

test('the module never touches sessionStorage or localStorage', () => {
  // This store has NO identity stamp. That is safe only because it dies with the
  // page. Mirroring it to browser storage without first adding the Accounting
  // store's identity envelope would leak one Orphanage user's roster, addresses
  // and gift backlog to the next person on that browser tab.
  const src = readFileSync(
    path.join(process.cwd(), 'src', 'lib', 'orphanage', 'tab-cache.ts'),
    'utf8',
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/sessionStorage/.test(code), 'must not use sessionStorage');
  assert.ok(!/localStorage/.test(code), 'must not use localStorage');
  assert.ok(!/document\.cookie/.test(code), 'must not use cookies');
});

test('the freshness window matches the documented 30s', () => {
  assert.equal(FRESH_WINDOW_MS, 30_000);
});
