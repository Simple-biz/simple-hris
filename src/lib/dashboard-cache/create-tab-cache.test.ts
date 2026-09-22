import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTabCache } from './create-tab-cache';

/**
 * The factory behind the QC, Contractor and Tickets stores. It has to hold every
 * failure class the seven hand-written stores pin individually, because a bug
 * here is a bug in all three at once:
 *   1. cross-viewer paint (two people on one machine, or a `?email=` override)
 *   2. residue after a viewer swap, including keys an older deploy wrote
 *   3. a stale entry past the 12h ceiling painting as current
 *   4. schema drift
 *   5. storage unavailable / quota → degrade, never throw
 *   6. inert-until-bound, which closes (1) on a cold reload
 *   7. no skip-fetch flag reachable from anything this returns
 *   8. one store's purge never reaches another store's keys
 */

function fakeStorage(): Storage & { failWrites: boolean } {
  const map = new Map<string, string>();
  return {
    failWrites: false,
    get length() {
      return map.size;
    },
    key(i: number) {
      return Array.from(map.keys())[i] ?? null;
    },
    getItem(k: string) {
      return map.get(k) ?? null;
    },
    setItem(this: { failWrites: boolean }, k: string, v: string) {
      if (this.failWrites) throw new DOMException('QuotaExceededError');
      map.set(k, v);
    },
    removeItem(k: string) {
      map.delete(k);
    },
    clear() {
      map.clear();
    },
  } as Storage & { failWrites: boolean };
}

function newTab(prefix = 'qc-tab:', version = 1) {
  const cache = createTabCache(prefix, version);
  const s = fakeStorage();
  cache.__setStorage(s);
  return { cache, s };
}

/** A fresh module instance over the SAME storage — what a reload looks like. */
function reload(s: Storage, prefix = 'qc-tab:', version = 1) {
  const cache = createTabCache(prefix, version);
  cache.__setStorage(s);
  return cache;
}

test('a remount keeps the cached value — the point of the module', () => {
  const { cache, s } = newTab();
  cache.bindIdentity('kaner@simple.biz');
  cache.set('overview', { rows: [1, 2, 3] });

  const after = reload(s);
  assert.equal(after.get('overview'), undefined, 'inert until re-bound');
  after.bindIdentity('kaner@simple.biz');
  assert.deepEqual(after.get('overview'), { rows: [1, 2, 3] });
});

test('class 1 — another viewer on the same machine never reads the entry', () => {
  const { cache, s } = newTab();
  cache.bindIdentity('kaner@simple.biz');
  cache.set('overview', { rows: [1] });

  const after = reload(s);
  after.bindIdentity('other@simple.biz');
  assert.equal(after.get('overview'), undefined);
  assert.equal(s.getItem('qc-tab:overview'), null, 'purged, not merely unreadable');
});

test('class 1 — an identity stamp from another viewer is rejected on the same key', () => {
  const { cache, s } = newTab();
  cache.bindIdentity('kaner@simple.biz');
  cache.set('overview', 'mine');
  // Hand-forge an entry stamped for someone else, as a stale deploy might leave.
  s.setItem(
    'qc-tab:forged',
    JSON.stringify({ v: 1, id: 'other@simple.biz', at: Date.now(), data: 'theirs' }),
  );
  assert.equal(cache.get('forged'), undefined);
});

test('class 2 — a viewer swap purges keys this build does not even know about', () => {
  const { cache, s } = newTab();
  cache.bindIdentity('kaner@simple.biz');
  s.setItem(
    'qc-tab:retired-by-an-older-deploy',
    JSON.stringify({ v: 1, id: 'kaner@simple.biz', at: Date.now(), data: 'x' }),
  );
  cache.bindIdentity('other@simple.biz');
  assert.equal(s.getItem('qc-tab:retired-by-an-older-deploy'), null);
});

test('class 3 — an entry past the 12h ceiling reads as absent and is evicted', () => {
  const { cache, s } = newTab();
  cache.bindIdentity('kaner@simple.biz');
  const thirteenHoursAgo = Date.now() - 13 * 60 * 60 * 1000;
  s.setItem(
    'qc-tab:stale',
    JSON.stringify({ v: 1, id: 'kaner@simple.biz', at: thirteenHoursAgo, data: 'friday' }),
  );
  assert.equal(cache.get('stale'), undefined);
  assert.equal(s.getItem('qc-tab:stale'), null, 'evicted, not just skipped');
});

test('class 4 — an entry written by another schema version reads as absent', () => {
  const { cache, s } = newTab();
  cache.bindIdentity('kaner@simple.biz');
  s.setItem(
    'qc-tab:old-shape',
    JSON.stringify({ v: 99, id: 'kaner@simple.biz', at: Date.now(), data: 'x' }),
  );
  assert.equal(cache.get('old-shape'), undefined);
});

test('class 4 — malformed JSON and missing envelope fields FAIL CLOSED', () => {
  const { cache, s } = newTab();
  cache.bindIdentity('kaner@simple.biz');
  s.setItem('qc-tab:a', 'not json at all');
  s.setItem('qc-tab:b', JSON.stringify({ v: 1, id: 'kaner@simple.biz' }));
  s.setItem('qc-tab:c', JSON.stringify('a bare string'));
  s.setItem('qc-tab:d', JSON.stringify(null));
  for (const k of ['a', 'b', 'c', 'd']) assert.equal(cache.get(k), undefined, k);
});

test('class 5 — a write that throws on quota degrades to memory, never throws', () => {
  const { cache, s } = newTab();
  cache.bindIdentity('kaner@simple.biz');
  s.failWrites = true;
  assert.doesNotThrow(() => cache.set('overview', { rows: [1] }));
  assert.deepEqual(cache.get('overview'), { rows: [1] }, 'still serves this page load');
});

test('class 5 — no storage at all (SSR / private mode) is inert, not fatal', () => {
  const cache = createTabCache('qc-tab:');
  cache.__setStorage(null);
  assert.doesNotThrow(() => cache.bindIdentity('kaner@simple.biz'));
  assert.doesNotThrow(() => cache.set('overview', 1));
  assert.equal(cache.get('overview'), 1, 'the in-memory copy still works');
});

test('class 6 — inert until bound: reads miss and writes no-op', () => {
  const { cache, s } = newTab();
  cache.set('overview', 'written while unbound');
  assert.equal(cache.get('overview'), undefined);
  assert.equal(s.getItem('qc-tab:overview'), null, 'nothing reached storage');
  assert.equal(cache.boundIdentity(), null);
});

test('class 7 — nothing returned can answer "already fetched"', () => {
  const { cache } = newTab();
  const banned = Object.keys(cache).filter((n) => /fetched|revalidat|skip|ttlHit|fresh/i.test(n));
  assert.deepEqual(banned, [], 'a skip-fetch flag must not be reachable from the factory');
});

test('class 8 — one store cannot read or purge another store\'s keys', () => {
  const s = fakeStorage();
  const qc = createTabCache('qc-tab:');
  const tickets = createTabCache('tkt-tab:');
  qc.__setStorage(s);
  tickets.__setStorage(s);
  qc.bindIdentity('kaner@simple.biz');
  tickets.bindIdentity('kaner@simple.biz');

  qc.set('shared-name', 'qc value');
  tickets.set('shared-name', 'tickets value');
  assert.equal(qc.get('shared-name'), 'qc value');
  assert.equal(tickets.get('shared-name'), 'tickets value');

  qc.clearAll();
  assert.equal(qc.get('shared-name'), undefined);
  assert.equal(tickets.get('shared-name'), 'tickets value', "the other store survives");
});

test('class 8 — a prefix without a trailing colon is REFUSED at construction', () => {
  // `qc-tab` would enumerate, and clearAll would delete, the keys of `qc-tab-archive`.
  assert.throws(() => createTabCache('qc-tab'), /must end in ":"/);
});

test('undefined means "nothing cached"; null, [] and 0 are real values', () => {
  const { cache } = newTab();
  cache.bindIdentity('kaner@simple.biz');
  cache.set('a', null);
  cache.set('b', []);
  cache.set('c', 0);
  cache.set('d', undefined);
  assert.equal(cache.get('a'), null);
  assert.deepEqual(cache.get('b'), []);
  assert.equal(cache.get('c'), 0);
  assert.equal(cache.get('d'), undefined, 'undefined is not a storable value');
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('d'), false);
});

test('clearing one key leaves the others', () => {
  const { cache } = newTab();
  cache.bindIdentity('kaner@simple.biz');
  cache.set('a', 1);
  cache.set('b', 2);
  cache.clear('a');
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 2);
});

test('readStamp reports the write time, for an "as of" label', () => {
  const { cache } = newTab();
  cache.bindIdentity('kaner@simple.biz');
  const before = Date.now();
  cache.set('a', 1);
  const at = cache.readStamp('a');
  assert.ok(typeof at === 'number' && at >= before, 'a real write time');
  assert.equal(cache.readStamp('never-written'), undefined);
});

test('binding the SAME viewer again keeps the entries', () => {
  const { cache } = newTab();
  cache.bindIdentity('kaner@simple.biz');
  cache.set('a', 1);
  // Shells re-bind from an effect on every render pass; this must not be a purge.
  cache.bindIdentity('KaneR@Simple.biz ');
  assert.equal(cache.get('a'), 1, 'normalised email — same viewer, same cache');
});

test('binding null purges and goes inert', () => {
  const { cache, s } = newTab();
  cache.bindIdentity('kaner@simple.biz');
  cache.set('a', 1);
  cache.bindIdentity(null);
  assert.equal(cache.boundIdentity(), null);
  assert.equal(cache.get('a'), undefined);
  assert.equal(s.getItem('qc-tab:a'), null);
});

test('capacity is bounded and evicts the oldest write first', () => {
  const { cache, s } = newTab();
  cache.bindIdentity('kaner@simple.biz');
  for (let i = 0; i < 40; i += 1) {
    s.setItem(
      `qc-tab:old-${i}`,
      JSON.stringify({ v: 1, id: 'kaner@simple.biz', at: 1000 + i, data: i }),
    );
  }
  cache.set('newest', 'keep me');
  const remaining = Array.from({ length: s.length }, (_, i) => s.key(i)).filter(
    (k): k is string => !!k && k.startsWith('qc-tab:') && k !== 'qc-tab:@identity',
  );
  assert.ok(remaining.length <= 32, `expected <= 32 entries, got ${remaining.length}`);
  assert.equal(cache.get('newest'), 'keep me', 'the write that triggered the trim survives');
  assert.equal(s.getItem('qc-tab:old-0'), null, 'the oldest went first');
});
