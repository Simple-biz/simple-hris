import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MANAGER_CACHE_KEYS,
  __resetManagerCacheMemory,
  __setManagerCacheStorage,
  bindManagerCacheIdentity,
  boundManagerCacheIdentity,
  clearAllManagerCache,
  clearManagerCache,
  getManagerCache,
  hasManagerCache,
  readManagerCacheStamp,
  setManagerCache,
} from './tab-cache';

/**
 * The Manager shell cache holds a manager's roster, their approval queue and
 * their transfer requests across a tab-switch remount and a reload. These tests
 * pin the failure classes that makes real:
 *
 *   1. cross-viewer paint — two managers sharing a machine, or one signing in
 *      after another, seeing each other's team
 *   2. residue after a viewer swap, including keys an older deploy wrote
 *   3. a stale queue past the age ceiling painting as this morning's work
 *   4. schema drift — a blob written by a previous deploy read by new code
 *   5. storage unavailable / quota exceeded → degrade, never throw
 *   6. the inert-until-bound rule, which is what closes (1) on a cold reload —
 *      and which this surface leans on harder than the Employee portal does,
 *      because `ManagerApp` renders its tabs BEFORE the viewer resolves
 *
 * Class 7 (a cache-only render that skips the fetch) is closed by construction,
 * not by a test: this module ships no "already fetched" flag for a caller to
 * consult. `no-skip-flag` below pins that absence so it cannot be added quietly.
 */

/** Minimal in-memory Storage, matching the parts the cache uses. */
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

/** Fresh module state + fresh storage, as if a brand-new browser tab. */
function newTab() {
  __resetManagerCacheMemory();
  const s = fakeStorage();
  __setManagerCacheStorage(s);
  return s;
}

/** A reload, or a tab-switch remount: storage survives, module memory may not. */
function reload(s: Storage) {
  __resetManagerCacheMemory();
  __setManagerCacheStorage(s);
}

const ROSTER = MANAGER_CACHE_KEYS.teamRoster;
const QUEUE = MANAGER_CACHE_KEYS.timeAdjustmentRows;

test('a tab-switch remount keeps the cached roster — the whole point of the module', () => {
  const s = newTab();
  bindManagerCacheIdentity('gyd@simple.biz');
  setManagerCache(ROSTER, { rows: [{ work_email: 'a@x.com' }], scope: 'department' });

  reload(s);
  // Nothing is readable until identity is re-bound (class 6).
  assert.equal(getManagerCache(ROSTER), undefined);

  bindManagerCacheIdentity('gyd@simple.biz');
  assert.deepEqual(getManagerCache(ROSTER), {
    rows: [{ work_email: 'a@x.com' }],
    scope: 'department',
  });
});

test('closing the tab drops everything — storage is not shared across tabs', () => {
  const first = newTab();
  bindManagerCacheIdentity('gyd@simple.biz');
  setManagerCache(ROSTER, { rows: [] });
  assert.ok(hasManagerCache(ROSTER));

  newTab();
  bindManagerCacheIdentity('gyd@simple.biz');
  assert.equal(getManagerCache(ROSTER), undefined);
  assert.ok(first.getItem(`mgr-tab:${ROSTER}`), 'the old tab still had its own copy');
});

test('class 1 — another manager on the same machine never reads this roster', () => {
  const s = newTab();
  bindManagerCacheIdentity('gyd@simple.biz');
  setManagerCache(ROSTER, { rows: [{ work_email: 'mine@x.com' }] });

  reload(s);
  bindManagerCacheIdentity('other@simple.biz');
  assert.equal(
    getManagerCache(ROSTER),
    undefined,
    "one manager's team must never paint into another's shell",
  );
});

test('class 1 — a stamp from another viewer is rejected even on the same key', () => {
  const s = newTab();
  bindManagerCacheIdentity('gyd@simple.biz');
  setManagerCache(QUEUE, [{ id: 'a' }]);
  // Somebody else's write lands under the same key while we are still bound.
  const raw = JSON.parse(s.getItem(`mgr-tab:${QUEUE}`) as string) as Record<string, unknown>;
  s.setItem(`mgr-tab:${QUEUE}`, JSON.stringify({ ...raw, id: 'other@simple.biz' }));
  __resetManagerCacheMemory();
  __setManagerCacheStorage(s);
  bindManagerCacheIdentity('gyd@simple.biz');
  assert.equal(getManagerCache(QUEUE), undefined);
});

test('identity is normalised — casing and whitespace do not read as a new person', () => {
  const s = newTab();
  bindManagerCacheIdentity('gyd@simple.biz');
  setManagerCache(ROSTER, { rows: [1] });

  reload(s);
  bindManagerCacheIdentity('  GYD@Simple.Biz  ');
  assert.deepEqual(getManagerCache(ROSTER), { rows: [1] });
  assert.equal(boundManagerCacheIdentity(), 'gyd@simple.biz');
});

test('class 2 — a viewer swap leaves nothing for the next person on that tab', () => {
  const s = newTab();
  bindManagerCacheIdentity('gyd@simple.biz');
  setManagerCache(ROSTER, { rows: [1] });
  setManagerCache(QUEUE, [{ id: 'a' }]);

  reload(s);
  bindManagerCacheIdentity('other@simple.biz');
  assert.equal(s.getItem(`mgr-tab:${ROSTER}`), null, 'purged from storage, not merely unreadable');
  assert.equal(s.getItem(`mgr-tab:${QUEUE}`), null);
});

test('class 2 — a purge also clears keys this build does not know about', () => {
  const s = newTab();
  bindManagerCacheIdentity('gyd@simple.biz');
  s.setItem('mgr-tab:retired:some-old-key', JSON.stringify({ v: 1, id: 'gyd@simple.biz', at: Date.now(), data: 1 }));
  s.setItem('unrelated:key', 'keep me');

  clearAllManagerCache();
  assert.equal(s.getItem('mgr-tab:retired:some-old-key'), null);
  assert.equal(s.getItem('unrelated:key'), 'keep me', 'only this module’s prefix is ours to drop');
});

test('class 3 — an entry past the 12h ceiling reads as absent and is evicted', () => {
  const s = newTab();
  bindManagerCacheIdentity('gyd@simple.biz');
  const stale = { v: 1, id: 'gyd@simple.biz', at: Date.now() - 13 * 60 * 60 * 1000, data: [{ id: 'old' }] };
  s.setItem(`mgr-tab:${QUEUE}`, JSON.stringify(stale));

  assert.equal(getManagerCache(QUEUE), undefined, 'a lid closed on Friday must not paint Monday');
  assert.equal(s.getItem(`mgr-tab:${QUEUE}`), null, 'and it is dropped, not left to be re-read');
});

test('class 3 — an entry just inside the ceiling still paints', () => {
  const s = newTab();
  bindManagerCacheIdentity('gyd@simple.biz');
  const fresh = { v: 1, id: 'gyd@simple.biz', at: Date.now() - 11 * 60 * 60 * 1000, data: [{ id: 'ok' }] };
  s.setItem(`mgr-tab:${QUEUE}`, JSON.stringify(fresh));

  assert.deepEqual(getManagerCache(QUEUE), [{ id: 'ok' }]);
});

test('class 3 — the write stamp is readable, so a surface can say "as of"', () => {
  newTab();
  bindManagerCacheIdentity('gyd@simple.biz');
  const before = Date.now();
  setManagerCache(ROSTER, { rows: [] });
  const at = readManagerCacheStamp(ROSTER);
  assert.ok(at !== undefined && at >= before);
  assert.equal(readManagerCacheStamp('nothing:here'), undefined);
});

test('class 4 — a blob from a previous schema version is ignored', () => {
  const s = newTab();
  bindManagerCacheIdentity('gyd@simple.biz');
  s.setItem(`mgr-tab:${ROSTER}`, JSON.stringify({ v: 0, id: 'gyd@simple.biz', at: Date.now(), data: { rows: ['old shape'] } }));

  assert.equal(getManagerCache(ROSTER), undefined);
});

test('class 4 — corrupt and non-envelope payloads read as absent, never throw', () => {
  const s = newTab();
  bindManagerCacheIdentity('gyd@simple.biz');
  for (const bad of ['not json at all', '"a bare string"', 'null', '{"v":1}', '[]']) {
    s.setItem(`mgr-tab:${ROSTER}`, bad);
    assert.equal(getManagerCache(ROSTER), undefined, `payload ${bad} must not paint`);
  }
});

test('class 5 — a quota-exceeded write degrades to memory instead of throwing', () => {
  const s = newTab();
  bindManagerCacheIdentity('gyd@simple.biz');
  s.failWrites = true;
  assert.doesNotThrow(() => setManagerCache(ROSTER, { rows: [1] }));
  // The in-memory copy still serves this page load.
  assert.deepEqual(getManagerCache(ROSTER), { rows: [1] });
});

test('class 5 — no storage at all (private mode) is memory-only, not a crash', () => {
  __resetManagerCacheMemory();
  __setManagerCacheStorage(null);
  bindManagerCacheIdentity('gyd@simple.biz');
  assert.doesNotThrow(() => setManagerCache(ROSTER, { rows: [1] }));
  assert.deepEqual(getManagerCache(ROSTER), { rows: [1] });
});

test('class 5 — storage cannot be filled without eviction of the oldest', () => {
  const s = newTab();
  bindManagerCacheIdentity('gyd@simple.biz');
  // Keys left behind by older deploys accumulate under the same prefix; the
  // ceiling has to hold whatever the prefix contains, not just today's key list.
  for (let i = 0; i < 40; i += 1) setManagerCache(`legacy:key-${i}`, { i });
  const stored = Array.from({ length: s.length }, (_, i) => s.key(i)).filter(
    (k): k is string => !!k && k.startsWith('mgr-tab:') && k !== 'mgr-tab:@identity',
  );
  assert.ok(stored.length <= 32, `capacity held at ${stored.length}`);
  // The newest write is the one that must survive.
  assert.deepEqual(getManagerCache('legacy:key-39'), { i: 39 });
});

test('class 6 — writes before identity is bound are dropped, not deferred', () => {
  const s = newTab();
  setManagerCache(ROSTER, { rows: ['leaked'] });
  assert.equal(s.getItem(`mgr-tab:${ROSTER}`), null);

  bindManagerCacheIdentity('gyd@simple.biz');
  assert.equal(
    getManagerCache(ROSTER),
    undefined,
    'an unbound write must not resurface once somebody binds',
  );
});

test('class 6 — the first render of ManagerApp reads an inert cache', () => {
  // ManagerApp renders its tabs before `viewerEmail` resolves. That render must
  // behave exactly as it did before this cache existed — which is also what
  // keeps SSR and the first client render in agreement.
  const s = newTab();
  bindManagerCacheIdentity('gyd@simple.biz');
  setManagerCache(ROSTER, { rows: [1] });

  reload(s);
  assert.equal(boundManagerCacheIdentity(), null);
  assert.equal(getManagerCache(ROSTER), undefined);
  assert.equal(hasManagerCache(ROSTER), false);
});

test('class 6 — binding null purges and returns the cache to inert', () => {
  const s = newTab();
  bindManagerCacheIdentity('gyd@simple.biz');
  setManagerCache(ROSTER, { rows: [1] });

  bindManagerCacheIdentity(null);
  assert.equal(boundManagerCacheIdentity(), null);
  assert.equal(s.getItem(`mgr-tab:${ROSTER}`), null);
  assert.equal(s.getItem('mgr-tab:@identity'), null);
});

test('undefined is reserved for "nothing cached" — null and [] are real values', () => {
  newTab();
  bindManagerCacheIdentity('gyd@simple.biz');
  setManagerCache(MANAGER_CACHE_KEYS.viewerName, null);
  assert.equal(getManagerCache(MANAGER_CACHE_KEYS.viewerName), null);
  assert.ok(hasManagerCache(MANAGER_CACHE_KEYS.viewerName));

  setManagerCache(QUEUE, []);
  assert.deepEqual(getManagerCache(QUEUE), []);

  setManagerCache(ROSTER, undefined);
  assert.equal(hasManagerCache(ROSTER), false, 'undefined is never stored');
});

test('a cached zero count is a value, not a miss', () => {
  newTab();
  bindManagerCacheIdentity('gyd@simple.biz');
  setManagerCache(MANAGER_CACHE_KEYS.pendingLeaveCount, 0);
  assert.equal(getManagerCache(MANAGER_CACHE_KEYS.pendingLeaveCount), 0);
  assert.ok(hasManagerCache(MANAGER_CACHE_KEYS.pendingLeaveCount));
});

test('clearing one key leaves the others alone', () => {
  newTab();
  bindManagerCacheIdentity('gyd@simple.biz');
  setManagerCache(ROSTER, { rows: [1] });
  setManagerCache(QUEUE, [{ id: 'a' }]);

  clearManagerCache(ROSTER);
  assert.equal(getManagerCache(ROSTER), undefined);
  assert.deepEqual(getManagerCache(QUEUE), [{ id: 'a' }]);
});

test('every key is uniquely spelled', () => {
  const all = Object.values(MANAGER_CACHE_KEYS);
  assert.equal(new Set(all).size, all.length, `duplicate cache key: ${all.join(', ')}`);
});

test('no key collides with the identity marker', () => {
  const fixed = Object.entries(MANAGER_CACHE_KEYS)
    .filter(([, v]) => typeof v === 'string')
    .map(([, v]) => `mgr-tab:${v as string}`);
  assert.ok(!fixed.includes('mgr-tab:@identity'));
});

test('no-skip-flag — the module exposes nothing a caller could use to skip a fetch', async () => {
  // Closed by construction. Accounting's cache ships `hasFetchedThisSession`;
  // on a surface where other people empty the queue you are looking at, that
  // flag would freeze one manager's view of work somebody else has since done.
  // This pins the absence so it cannot reappear by copy-paste.
  const mod: Record<string, unknown> = await import('./tab-cache');
  const banned = Object.keys(mod).filter((n) => /fetched|revalidat|skip|ttlHit/i.test(n));
  assert.deepEqual(
    banned,
    [],
    `stale-while-revalidate is the contract; found skip-flag-shaped export(s): ${banned.join(', ')}`,
  );
});

test('no key caches presence or a signed URL — both are wrong when stale', () => {
  const spelled = Object.entries(MANAGER_CACHE_KEYS)
    .filter(([, v]) => typeof v === 'string')
    .map(([k, v]) => `${k}:${v as string}`)
    .join(' ');
  assert.ok(
    !/presence|last-seen|lastSeen|signed/i.test(spelled),
    'presence is a liveness signal and signed URLs expire — neither may be cached',
  );
});
