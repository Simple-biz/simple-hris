import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPLOYEE_CACHE_KEYS,
  __resetEmployeeCacheMemory,
  __setEmployeeCacheStorage,
  bindEmployeeCacheIdentity,
  boundEmployeeCacheIdentity,
  clearAllEmployeeCache,
  clearEmployeeCache,
  getEmployeeCache,
  hasEmployeeCache,
  readEmployeeCacheStamp,
  setEmployeeCache,
} from './tab-cache';

/**
 * The Employee portal cache persists pay-adjacent data across a page reload
 * (sessionStorage), which puts one person's figures on disk in a tab that
 * another person may sign into and that an elevated viewer may use to preview
 * someone else's portal. These tests pin the failure classes that makes real:
 *
 *   1. cross-identity paint — an elevated `?email=` preview bleeding into the
 *      viewer's own portal in the same tab
 *   2. post-sign-out residue — the next person to sign in on that tab
 *   3. stale money — an entry older than the age ceiling painting as current
 *   4. schema drift — a blob written by a previous deploy read by new code
 *   5. storage unavailable / quota exceeded → degrade, never throw
 *   6. the inert-until-bound rule, which is what closes (1) on a cold reload
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
  __resetEmployeeCacheMemory();
  const s = fakeStorage();
  __setEmployeeCacheStorage(s);
  return s;
}

/** A reload: storage survives, module memory does not. */
function reload(s: Storage) {
  __resetEmployeeCacheMemory();
  __setEmployeeCacheStorage(s);
}

test('a reload keeps the cached value — the whole point of the module', () => {
  const s = newTab();
  bindEmployeeCacheIdentity('jane@simple.biz');
  setEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow, { name: 'Jane', startDate: '2025-01-06' });

  reload(s);
  // Nothing is readable until identity is re-bound (class 6).
  assert.equal(getEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow), undefined);

  bindEmployeeCacheIdentity('jane@simple.biz');
  assert.deepEqual(getEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow), {
    name: 'Jane',
    startDate: '2025-01-06',
  });
});

test('closing the tab drops everything — storage is not shared across tabs', () => {
  const first = newTab();
  bindEmployeeCacheIdentity('jane@simple.biz');
  setEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow, { name: 'Jane' });
  assert.ok(hasEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow));

  // A new tab gets its own sessionStorage; nothing from `first` is reachable.
  newTab();
  bindEmployeeCacheIdentity('jane@simple.biz');
  assert.equal(getEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow), undefined);
  assert.ok(first.getItem('emp-cache:employee:master-row'), 'the old tab still had its own copy');
});

test('class 1 — binding a different identity purges before anything can read it', () => {
  const s = newTab();
  // An elevated viewer previews Jane's portal via ?email=.
  bindEmployeeCacheIdentity('jane@simple.biz');
  setEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow, { name: 'Jane', pay: 19080.76 });

  // Same tab, now their own portal.
  bindEmployeeCacheIdentity('kaner@simple.biz');
  assert.equal(
    getEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow),
    undefined,
    "Jane's row must not paint into Kane's portal",
  );
  assert.equal(s.getItem('emp-cache:employee:master-row'), null, 'and must be off disk too');
});

test('class 1 — the purge survives a reload, not just an in-memory swap', () => {
  const s = newTab();
  bindEmployeeCacheIdentity('jane@simple.biz');
  setEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow, { name: 'Jane' });

  reload(s);
  bindEmployeeCacheIdentity('kaner@simple.biz');
  assert.equal(getEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow), undefined);
});

test('class 1 — a hand-forged entry stamped with another identity is rejected', () => {
  const s = newTab();
  s.setItem(
    'emp-cache:employee:master-row',
    JSON.stringify({ v: 1, id: 'jane@simple.biz', at: Date.now(), data: { name: 'Jane' } }),
  );
  bindEmployeeCacheIdentity('kaner@simple.biz');
  assert.equal(getEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow), undefined);
});

test('identity is normalised — casing and whitespace do not read as a new person', () => {
  const s = newTab();
  bindEmployeeCacheIdentity('jane@simple.biz');
  setEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow, { name: 'Jane' });

  reload(s);
  bindEmployeeCacheIdentity('  Jane@Simple.biz  ');
  assert.equal(boundEmployeeCacheIdentity(), 'jane@simple.biz');
  assert.deepEqual(getEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow), { name: 'Jane' });
});

test('class 2 — sign-out purges, leaving nothing for the next person on that tab', () => {
  const s = newTab();
  bindEmployeeCacheIdentity('jane@simple.biz');
  setEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow, { name: 'Jane' });
  setEmployeeCache(EMPLOYEE_CACHE_KEYS.paidPaystubWeeks, ['2026-08-23']);

  clearAllEmployeeCache();
  assert.equal(s.length, 0, 'no residue on disk, identity marker included');

  bindEmployeeCacheIdentity('kaner@simple.biz');
  assert.equal(getEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow), undefined);
  assert.equal(getEmployeeCache(EMPLOYEE_CACHE_KEYS.paidPaystubWeeks), undefined);
});

test('class 2 — a purge also clears keys this build does not know about', () => {
  const s = newTab();
  bindEmployeeCacheIdentity('jane@simple.biz');
  // Left behind by an older deploy that cached a since-removed dataset.
  s.setItem('emp-cache:employee:retired-dataset', JSON.stringify({ v: 1, id: 'jane@simple.biz', at: Date.now(), data: 1 }));

  clearAllEmployeeCache();
  assert.equal(s.getItem('emp-cache:employee:retired-dataset'), null);
});

test('class 3 — an entry past the 12h ceiling reads as absent and is evicted', () => {
  const s = newTab();
  const thirteenHoursAgo = Date.now() - 13 * 60 * 60 * 1000;
  s.setItem(
    'emp-cache:employee:master-row',
    JSON.stringify({ v: 1, id: 'jane@simple.biz', at: thirteenHoursAgo, data: { pay: 1 } }),
  );
  bindEmployeeCacheIdentity('jane@simple.biz');

  assert.equal(getEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow), undefined);
  assert.equal(s.getItem('emp-cache:employee:master-row'), null, 'evicted, not just hidden');
});

test('class 3 — an entry just inside the ceiling still paints', () => {
  const s = newTab();
  const elevenHoursAgo = Date.now() - 11 * 60 * 60 * 1000;
  s.setItem(
    'emp-cache:employee:master-row',
    JSON.stringify({ v: 1, id: 'jane@simple.biz', at: elevenHoursAgo, data: { pay: 1 } }),
  );
  bindEmployeeCacheIdentity('jane@simple.biz');
  assert.deepEqual(getEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow), { pay: 1 });
});

test('class 3 — the write stamp is readable, so a surface can say "as of"', () => {
  newTab();
  bindEmployeeCacheIdentity('jane@simple.biz');
  const before = Date.now();
  setEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow, { pay: 1 });
  const stamp = readEmployeeCacheStamp(EMPLOYEE_CACHE_KEYS.masterRow);
  assert.ok(stamp !== undefined && stamp >= before && stamp <= Date.now());
});

test('class 4 — a blob from a previous schema version is ignored', () => {
  const s = newTab();
  s.setItem(
    'emp-cache:employee:master-row',
    JSON.stringify({ v: 0, id: 'jane@simple.biz', at: Date.now(), data: { oldShape: true } }),
  );
  bindEmployeeCacheIdentity('jane@simple.biz');
  assert.equal(getEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow), undefined);
});

test('class 4 — corrupt and non-envelope payloads read as absent, never throw', () => {
  const s = newTab();
  bindEmployeeCacheIdentity('jane@simple.biz');
  for (const junk of ['not json', '[]', 'null', '{"v":1}', '{"v":"1","id":"jane@simple.biz","at":1,"data":1}']) {
    s.setItem('emp-cache:employee:master-row', junk);
    assert.equal(getEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow), undefined, junk);
  }
});

test('class 5 — a quota-exceeded write degrades to memory instead of throwing', () => {
  const s = newTab();
  bindEmployeeCacheIdentity('jane@simple.biz');
  s.failWrites = true;

  assert.doesNotThrow(() => setEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow, { pay: 1 }));
  // Still served in-process this page load...
  assert.deepEqual(getEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow), { pay: 1 });
  // ...but the reload simply misses, which costs a fetch and nothing more.
  s.failWrites = false;
  reload(s);
  bindEmployeeCacheIdentity('jane@simple.biz');
  assert.equal(getEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow), undefined);
});

test('class 5 — no storage at all (private mode) is memory-only, not a crash', () => {
  __resetEmployeeCacheMemory();
  __setEmployeeCacheStorage(null); // and `window` is undefined under node:test
  assert.doesNotThrow(() => bindEmployeeCacheIdentity('jane@simple.biz'));
  assert.doesNotThrow(() => setEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow, { pay: 1 }));
  assert.deepEqual(getEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow), { pay: 1 });
  assert.doesNotThrow(() => clearAllEmployeeCache());
});

test('class 6 — writes before identity is bound are dropped, not deferred', () => {
  const s = newTab();
  setEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow, { pay: 1 });
  assert.equal(s.length, 0);

  bindEmployeeCacheIdentity('jane@simple.biz');
  assert.equal(
    getEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow),
    undefined,
    'an unattributed value must never acquire an identity retroactively',
  );
});

test('class 6 — binding null purges and returns the cache to inert', () => {
  const s = newTab();
  bindEmployeeCacheIdentity('jane@simple.biz');
  setEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow, { pay: 1 });

  bindEmployeeCacheIdentity(null);
  assert.equal(boundEmployeeCacheIdentity(), null);
  assert.equal(s.length, 0);
});

test('undefined is reserved for "nothing cached" — null and [] are real values', () => {
  newTab();
  bindEmployeeCacheIdentity('jane@simple.biz');

  setEmployeeCache(EMPLOYEE_CACHE_KEYS.specialTransfers, []);
  assert.deepEqual(getEmployeeCache(EMPLOYEE_CACHE_KEYS.specialTransfers), []);
  assert.equal(hasEmployeeCache(EMPLOYEE_CACHE_KEYS.specialTransfers), true);

  setEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow, null);
  assert.equal(getEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow), null);
  assert.equal(hasEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow), true);

  setEmployeeCache(EMPLOYEE_CACHE_KEYS.rateHistory, undefined);
  assert.equal(hasEmployeeCache(EMPLOYEE_CACHE_KEYS.rateHistory), false);
});

test('clearing one key leaves the others alone', () => {
  newTab();
  bindEmployeeCacheIdentity('jane@simple.biz');
  setEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow, { pay: 1 });
  setEmployeeCache(EMPLOYEE_CACHE_KEYS.paidPaystubWeeks, ['2026-08-23']);

  clearEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow);
  assert.equal(getEmployeeCache(EMPLOYEE_CACHE_KEYS.masterRow), undefined);
  assert.deepEqual(getEmployeeCache(EMPLOYEE_CACHE_KEYS.paidPaystubWeeks), ['2026-08-23']);
});

test('parameterised keys separate the datasets they select', () => {
  // The registry ships no key factory today, but the store must support one —
  // a future per-week or per-window dataset has to stay isolated per parameter.
  newTab();
  bindEmployeeCacheIdentity('jane@simple.biz');
  const aug = 'employee:disputes:2026-08-01:2026-08-31';
  const jul = 'employee:disputes:2026-07-01:2026-07-31';

  setEmployeeCache(aug, [{ id: 'a' }]);
  assert.equal(getEmployeeCache(jul), undefined);
  assert.deepEqual(getEmployeeCache(aug), [{ id: 'a' }]);
});

test('every registry key is a plain string and uniquely spelled', () => {
  const values = Object.values(EMPLOYEE_CACHE_KEYS);
  for (const v of values) assert.equal(typeof v, 'string');
  assert.equal(new Set(values).size, values.length, 'two datasets share a cache key');
});

test('no-skip-flag — the module exposes nothing a caller could use to skip a fetch', async () => {
  // Class 7 is closed by construction. Accounting's cache ships
  // `hasFetchedThisSession`; on a surface where an already-PAID row can be
  // re-staged underneath a cached copy, that flag would freeze a superseded pay
  // figure on screen. This pins the absence so it cannot reappear by copy-paste.
  const mod: Record<string, unknown> = await import('./tab-cache');
  const banned = Object.keys(mod).filter((n) => /fetched|revalidat|skip|ttlHit/i.test(n));
  assert.deepEqual(
    banned,
    [],
    `stale-while-revalidate is the contract; found skip-flag-shaped export(s): ${banned.join(', ')}`,
  );
});
