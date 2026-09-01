import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  KPI_CACHE_KEYS,
  __resetKpiCacheMemory,
  __setKpiCacheStorage,
  bindKpiCacheIdentity,
  boundKpiCacheIdentity,
  clearAllKpiCache,
  clearKpiCache,
  deptSurface,
  getKpiCache,
  hasKpiCache,
  readKpiCacheStamp,
  setKpiCache,
} from './kpi-cache';

/**
 * The Manager KPI Calculator cache holds scored bonus rows — money, for a
 * specific `(department, period_start)` — across a tab-switch remount and a
 * reload. These tests pin the failure classes that makes real:
 *
 *   1. cross-viewer paint — two managers sharing a machine, or one signing in
 *      after another, seeing each other's branches
 *   2. residue after a viewer swap, including keys an older deploy wrote
 *   3. stale money — an entry past the age ceiling painting as this week's work
 *   4. schema drift — a blob written by a previous deploy read by new code
 *   5. storage unavailable / quota exceeded → degrade, never throw
 *   6. the inert-until-bound rule, which is what closes (1) on a cold reload
 *   7. **cross-WEEK paint** — last week's scores under this week's key. This is
 *      the one class this surface has that the Employee portal does not, and it
 *      is the expensive one: `(department, period_start)` is a KPI row's only
 *      address, so a week mix-up is how a manager scores into a week nobody
 *      reads (`docs/features/hsl-kpi-calculator-2026-07.md` → First-load reveal).
 *   8. cross-VARIANT paint — a QC officer's `qc_kpi_submissions` first-pass
 *      painting as the official `bonus_catalog_applied` rows, or vice versa.
 *
 * Class 9 (a cache-only render that skips the fetch) is closed by construction,
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
  __resetKpiCacheMemory();
  const s = fakeStorage();
  __setKpiCacheStorage(s);
  return s;
}

/** A reload, or a tab-switch remount: storage survives, module memory may not. */
function reload(s: Storage) {
  __resetKpiCacheMemory();
  __setKpiCacheStorage(s);
}

const WEEK = '2026-08-23';
const PRIOR = '2026-08-16';
const CALLBACK = KPI_CACHE_KEYS.hslBranch('callback_team', WEEK);

test('a remount keeps the cached branch — the whole point of the module', () => {
  const s = newTab();
  bindKpiCacheIdentity('gyd@simple.biz');
  setKpiCache(CALLBACK, { entries: [{ employee_email: 'a@x.com', calculated_bonus: 250 }] });

  reload(s);
  // Nothing is readable until identity is re-bound (class 6).
  assert.equal(getKpiCache(CALLBACK), undefined);

  bindKpiCacheIdentity('gyd@simple.biz');
  assert.deepEqual(getKpiCache(CALLBACK), {
    entries: [{ employee_email: 'a@x.com', calculated_bonus: 250 }],
  });
});

test('closing the tab drops everything — storage is not shared across tabs', () => {
  const first = newTab();
  bindKpiCacheIdentity('gyd@simple.biz');
  setKpiCache(CALLBACK, { entries: [] });
  assert.ok(hasKpiCache(CALLBACK));

  newTab();
  bindKpiCacheIdentity('gyd@simple.biz');
  assert.equal(getKpiCache(CALLBACK), undefined);
  assert.ok(first.getItem(`mgr-kpi:${CALLBACK}`), 'the old tab still had its own copy');
});

test('class 7 — a different payroll week is a different key, never a stale paint', () => {
  newTab();
  bindKpiCacheIdentity('gyd@simple.biz');
  setKpiCache(KPI_CACHE_KEYS.hslBranch('callback_team', PRIOR), { entries: [{ b: 4000 }] });

  assert.equal(
    getKpiCache(KPI_CACHE_KEYS.hslBranch('callback_team', WEEK)),
    undefined,
    "last week's scores must not paint as this week's",
  );
  assert.deepEqual(getKpiCache(KPI_CACHE_KEYS.hslBranch('callback_team', PRIOR)), {
    entries: [{ b: 4000 }],
  });
});

test('class 7 — the presumed week is a value to read, never a resolved-week flag', () => {
  newTab();
  bindKpiCacheIdentity('gyd@simple.biz');
  const key = KPI_CACHE_KEYS.presumedWeek('hsl');
  setKpiCache(key, PRIOR);

  // All a consumer can learn is WHICH week was last resolved live. Whether the
  // week is resolved *now* is not knowable from here — that stays with the live
  // Hubstaff fetch, which is what every write is held on.
  assert.equal(getKpiCache(key), PRIOR);
  assert.equal(typeof getKpiCache(key), 'string');
});

test('class 8 — manager and QC variants of the same dept-week never collide', () => {
  newTab();
  bindKpiCacheIdentity('gyd@simple.biz');
  const mgr = KPI_CACHE_KEYS.deptApplied(deptSurface('manager'), 'callback', WEEK);
  const qc = KPI_CACHE_KEYS.deptApplied(deptSurface('qc'), 'callback', WEEK);
  assert.notEqual(mgr, qc);

  setKpiCache(qc, { applied: [{ bonus_id: 'first-pass' }] });
  assert.equal(
    getKpiCache(mgr),
    undefined,
    'a QC first-pass must not paint as the official applied rows',
  );

  setKpiCache(mgr, { applied: [{ bonus_id: 'official' }] });
  assert.deepEqual(getKpiCache(qc), { applied: [{ bonus_id: 'first-pass' }] });
});

test('class 8 — the HSL surface is separate from both department surfaces', () => {
  const surfaces = ['hsl', deptSurface('manager'), deptSurface('qc')] as const;
  assert.equal(new Set(surfaces).size, 3);
  assert.equal(new Set(surfaces.map((s) => KPI_CACHE_KEYS.presumedWeek(s))).size, 3);
});

test('class 1 — binding a different viewer purges before anything can read it', () => {
  const s = newTab();
  bindKpiCacheIdentity('gyd@simple.biz');
  setKpiCache(CALLBACK, { entries: [{ calculated_bonus: 12500 }] });

  bindKpiCacheIdentity('eula@simple.biz');
  assert.equal(
    getKpiCache(CALLBACK),
    undefined,
    "Gyd's branch must not paint into Eula's calculator",
  );
  assert.equal(s.getItem(`mgr-kpi:${CALLBACK}`), null, 'and must be off disk too');
});

test('class 1 — the purge survives a reload, not just an in-memory swap', () => {
  const s = newTab();
  bindKpiCacheIdentity('gyd@simple.biz');
  setKpiCache(CALLBACK, { entries: [] });

  reload(s);
  bindKpiCacheIdentity('eula@simple.biz');
  assert.equal(getKpiCache(CALLBACK), undefined);
});

test('class 1 — a hand-forged entry stamped with another viewer is rejected', () => {
  const s = newTab();
  s.setItem(
    `mgr-kpi:${CALLBACK}`,
    JSON.stringify({ v: 1, id: 'gyd@simple.biz', at: Date.now(), data: { entries: [] } }),
  );
  bindKpiCacheIdentity('eula@simple.biz');
  assert.equal(getKpiCache(CALLBACK), undefined);
});

test('identity is normalised — casing and whitespace do not read as a new person', () => {
  const s = newTab();
  bindKpiCacheIdentity('gyd@simple.biz');
  setKpiCache(CALLBACK, { entries: [] });

  reload(s);
  bindKpiCacheIdentity('  Gyd@Simple.biz  ');
  assert.equal(boundKpiCacheIdentity(), 'gyd@simple.biz');
  assert.deepEqual(getKpiCache(CALLBACK), { entries: [] });
});

test('class 2 — a full purge leaves nothing for the next person on that tab', () => {
  const s = newTab();
  bindKpiCacheIdentity('gyd@simple.biz');
  setKpiCache(CALLBACK, { entries: [] });
  setKpiCache(KPI_CACHE_KEYS.presumedWeek('hsl'), WEEK);

  clearAllKpiCache();
  assert.equal(s.length, 0, 'no residue on disk, identity marker included');

  bindKpiCacheIdentity('eula@simple.biz');
  assert.equal(getKpiCache(CALLBACK), undefined);
  assert.equal(getKpiCache(KPI_CACHE_KEYS.presumedWeek('hsl')), undefined);
});

test('class 2 — a purge also clears keys this build does not know about', () => {
  const s = newTab();
  bindKpiCacheIdentity('gyd@simple.biz');
  // Left behind by an older deploy that cached a since-retired department.
  s.setItem(
    'mgr-kpi:dept-manager:applied:smm_freelancer:2026-08-02',
    JSON.stringify({ v: 1, id: 'gyd@simple.biz', at: Date.now(), data: 1 }),
  );

  clearAllKpiCache();
  assert.equal(s.getItem('mgr-kpi:dept-manager:applied:smm_freelancer:2026-08-02'), null);
});

test('class 3 — an entry past the 12h ceiling reads as absent and is evicted', () => {
  const s = newTab();
  const thirteenHoursAgo = Date.now() - 13 * 60 * 60 * 1000;
  s.setItem(
    `mgr-kpi:${CALLBACK}`,
    JSON.stringify({ v: 1, id: 'gyd@simple.biz', at: thirteenHoursAgo, data: { entries: [] } }),
  );
  bindKpiCacheIdentity('gyd@simple.biz');

  assert.equal(getKpiCache(CALLBACK), undefined);
  assert.equal(s.getItem(`mgr-kpi:${CALLBACK}`), null, 'evicted, not just hidden');
});

test('class 3 — an entry just inside the ceiling still paints', () => {
  const s = newTab();
  const elevenHoursAgo = Date.now() - 11 * 60 * 60 * 1000;
  s.setItem(
    `mgr-kpi:${CALLBACK}`,
    JSON.stringify({ v: 1, id: 'gyd@simple.biz', at: elevenHoursAgo, data: { entries: [] } }),
  );
  bindKpiCacheIdentity('gyd@simple.biz');
  assert.deepEqual(getKpiCache(CALLBACK), { entries: [] });
});

test('class 3 — the write stamp is readable, so the surface can say "as of"', () => {
  newTab();
  bindKpiCacheIdentity('gyd@simple.biz');
  const before = Date.now();
  setKpiCache(CALLBACK, { entries: [] });
  const stamp = readKpiCacheStamp(CALLBACK);
  assert.ok(stamp !== undefined && stamp >= before && stamp <= Date.now());
});

test('class 4 — a blob from a previous schema version is ignored', () => {
  const s = newTab();
  s.setItem(
    `mgr-kpi:${CALLBACK}`,
    JSON.stringify({ v: 0, id: 'gyd@simple.biz', at: Date.now(), data: { oldShape: true } }),
  );
  bindKpiCacheIdentity('gyd@simple.biz');
  assert.equal(getKpiCache(CALLBACK), undefined);
});

test('class 4 — corrupt and non-envelope payloads read as absent, never throw', () => {
  const s = newTab();
  bindKpiCacheIdentity('gyd@simple.biz');
  for (const junk of [
    'not json',
    '[]',
    'null',
    '{"v":1}',
    '{"v":"1","id":"gyd@simple.biz","at":1,"data":1}',
  ]) {
    s.setItem(`mgr-kpi:${CALLBACK}`, junk);
    assert.equal(getKpiCache(CALLBACK), undefined, junk);
  }
});

test('class 5 — a quota-exceeded write degrades to memory instead of throwing', () => {
  const s = newTab();
  bindKpiCacheIdentity('gyd@simple.biz');
  s.failWrites = true;

  assert.doesNotThrow(() => setKpiCache(CALLBACK, { entries: [] }));
  // Still served in-process this page load...
  assert.deepEqual(getKpiCache(CALLBACK), { entries: [] });
  // ...but the remount simply misses, which costs a fetch and nothing more.
  s.failWrites = false;
  reload(s);
  bindKpiCacheIdentity('gyd@simple.biz');
  assert.equal(getKpiCache(CALLBACK), undefined);
});

test('class 5 — no storage at all (private mode) is memory-only, not a crash', () => {
  __resetKpiCacheMemory();
  __setKpiCacheStorage(null); // and `window` is undefined under node:test
  assert.doesNotThrow(() => bindKpiCacheIdentity('gyd@simple.biz'));
  assert.doesNotThrow(() => setKpiCache(CALLBACK, { entries: [] }));
  assert.deepEqual(getKpiCache(CALLBACK), { entries: [] });
  assert.doesNotThrow(() => clearAllKpiCache());
});

test('class 5 — a week picker cannot fill storage until the live week fails to write', () => {
  const s = newTab();
  bindKpiCacheIdentity('gyd@simple.biz');
  // A manager reading back through a quarter of history, one key per dept-week.
  for (let i = 0; i < 60; i += 1) {
    setKpiCache(KPI_CACHE_KEYS.hslBranch('callback_team', `2026-01-${String(i + 1).padStart(2, '0')}`), {
      entries: [i],
    });
  }
  assert.ok(s.length <= 48 + 1, `capped, got ${s.length} entries`);
  // The most recent write always survives its own trim.
  assert.deepEqual(getKpiCache(KPI_CACHE_KEYS.hslBranch('callback_team', '2026-01-60')), {
    entries: [59],
  });
});

test('class 6 — writes before identity is bound are dropped, not deferred', () => {
  const s = newTab();
  setKpiCache(CALLBACK, { entries: [] });
  assert.equal(s.length, 0);

  bindKpiCacheIdentity('gyd@simple.biz');
  assert.equal(
    getKpiCache(CALLBACK),
    undefined,
    'an unattributed value must never acquire an identity retroactively',
  );
});

test('class 6 — binding null purges and returns the cache to inert', () => {
  const s = newTab();
  bindKpiCacheIdentity('gyd@simple.biz');
  setKpiCache(CALLBACK, { entries: [] });

  bindKpiCacheIdentity(null);
  assert.equal(boundKpiCacheIdentity(), null);
  assert.equal(s.length, 0);
});

test('undefined is reserved for "nothing cached" — null and [] are real values', () => {
  newTab();
  bindKpiCacheIdentity('gyd@simple.biz');

  setKpiCache(CALLBACK, []);
  assert.deepEqual(getKpiCache(CALLBACK), []);
  assert.equal(hasKpiCache(CALLBACK), true);

  setKpiCache(CALLBACK, null);
  assert.equal(getKpiCache(CALLBACK), null);
  assert.equal(hasKpiCache(CALLBACK), true);

  setKpiCache(CALLBACK, undefined);
  assert.equal(getKpiCache(CALLBACK), null, 'an undefined write is a no-op, not a delete');
});

test('clearing one key leaves the others alone', () => {
  newTab();
  bindKpiCacheIdentity('gyd@simple.biz');
  const other = KPI_CACHE_KEYS.hslBranch('attestation', WEEK);
  setKpiCache(CALLBACK, { entries: [1] });
  setKpiCache(other, { entries: [2] });

  clearKpiCache(CALLBACK);
  assert.equal(getKpiCache(CALLBACK), undefined);
  assert.deepEqual(getKpiCache(other), { entries: [2] });
});

test('every key factory is uniquely spelled across its parameters', () => {
  const keys = [
    KPI_CACHE_KEYS.presumedWeek('hsl'),
    KPI_CACHE_KEYS.presumedWeek('dept-manager'),
    KPI_CACHE_KEYS.presumedWeek('dept-qc'),
    KPI_CACHE_KEYS.hslBranch('callback_team', WEEK),
    KPI_CACHE_KEYS.hslBranch('callback_team', PRIOR),
    KPI_CACHE_KEYS.hslBranch('attestation', WEEK),
    KPI_CACHE_KEYS.deptApplied('dept-manager', 'callback', WEEK),
    KPI_CACHE_KEYS.deptApplied('dept-qc', 'callback', WEEK),
    KPI_CACHE_KEYS.deptApplied('dept-manager', 'callback', PRIOR),
  ];
  for (const k of keys) assert.equal(typeof k, 'string');
  assert.equal(new Set(keys).size, keys.length, 'two datasets share a cache key');
});

test('no-skip-flag — the module exposes nothing a caller could use to skip a fetch', async () => {
  // Class 9 is closed by construction. Accounting's cache ships
  // `hasFetchedThisSession`; on a surface where other scorers edit the same
  // dept-week and `useLiveRefresh` re-pulls it, that flag would freeze one
  // manager's view of a week somebody else has since changed. This pins the
  // absence so it cannot reappear by copy-paste.
  const mod: Record<string, unknown> = await import('./kpi-cache');
  const banned = Object.keys(mod).filter((n) => /fetched|revalidat|skip|ttlHit/i.test(n));
  assert.deepEqual(
    banned,
    [],
    `stale-while-revalidate is the contract; found skip-flag-shaped export(s): ${banned.join(', ')}`,
  );
});
