import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_EMAIL_STORAGE_KEY,
  TAB_CACHE_KEYS,
  __resetAccountingCacheMemory,
  __setAccountingCacheStorage,
  bindAccountingCacheIdentity,
  boundAccountingCacheIdentity,
  clearAllAccountingCache,
  clearTabCache,
  getTabCache,
  hasFetchedThisSession,
  hasTabCache,
  markFetchedThisSession,
  readTabCacheStamp,
  setTabCache,
} from './tab-cache';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';

/**
 * The Accounting store is shared by three dashboards (Accounting, CEO,
 * Payroll-Clerk) and mirrored to `sessionStorage`, so it holds a company
 * roster, a dispatch queue and payout totals across a tab switch AND a reload.
 *
 * It predates `employee/tab-cache.ts` and `manager/tab-cache.ts` and shipped
 * without the envelope both of those were written against. These tests pin the
 * failure classes that gap left open:
 *
 *   1. cross-account paint — `acct-cache:*` surviving a sign-out into another account
 *   2. cross-identity paint — an `?email=` preview writing the same session key
 *      in the same tab
 *   3. schema drift — a blob written by a previous deploy read by new code
 *   4. unbounded staleness — a persisted entry with no age ceiling
 *   5. a skip-flag outliving the data it refers to
 *   6. storage unavailable / quota exceeded → degrade, never throw
 *
 * The skip-flag itself is NOT banned here, unlike in the other three stores:
 * `payroll-wizard-notes.md:120` documents two datasets as "fetched once per page
 * session" on purpose. What is pinned instead is the boundary — see
 * `the skip flag is confined to lookup lists and aggregate snapshots` below.
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
  __resetAccountingCacheMemory();
  const s = fakeStorage();
  __setAccountingCacheStorage(s);
  return s;
}

/** A reload, or a tab-switch remount: storage survives, module memory does not. */
function reload(s: Storage) {
  __resetAccountingCacheMemory();
  __setAccountingCacheStorage(s);
}

const ROSTER = TAB_CACHE_KEYS.peopleRoster;
const QUEUE = TAB_CACHE_KEYS.dispatchQueue;

// ── The session-email bridge ────────────────────────────────────────────────

test('the store’s session-email constant matches the RBAC one', () => {
  // The store declares this literal itself rather than importing a React module
  // into a storage leaf. If the two ever drift, the synchronous self-bind reads
  // a key nothing writes and the cache silently stops working on reload.
  assert.equal(SESSION_EMAIL_STORAGE_KEY, SESSION_EMAIL_KEY);
});

test('a read self-binds from the shell’s session email', () => {
  // This is what makes a `useState(getTabCache(...))` initialiser work on a
  // reload, before any shell effect has run. Without it the store would be
  // inert until bound and the mirror would never be read.
  const s = newTab();
  s.setItem(SESSION_EMAIL_KEY, 'kaner@simple.biz');
  setTabCache(ROSTER, [{ name: 'A' }]);
  reload(s);
  s.setItem(SESSION_EMAIL_KEY, 'kaner@simple.biz');
  assert.deepEqual(getTabCache(ROSTER), [{ name: 'A' }]);
  assert.equal(boundAccountingCacheIdentity(), 'kaner@simple.biz');
});

test('with no session email and no bind, the cache is inert', () => {
  const s = newTab();
  setTabCache(ROSTER, [{ name: 'A' }]);
  assert.equal(getTabCache(ROSTER), undefined, 'a write with no identity must no-op');
  assert.equal(s.length, 0);
});

// ── Class 1: sign-out ───────────────────────────────────────────────────────

test('sign-out purge leaves nothing on disk for the next person', () => {
  const s = newTab();
  bindAccountingCacheIdentity('kaner@simple.biz');
  setTabCache(ROSTER, [{ name: 'A' }]);
  setTabCache(QUEUE, [{ id: 1 }]);
  markFetchedThisSession(ROSTER);
  assert.ok(s.length > 0);

  clearAllAccountingCache();

  assert.equal(s.length, 0, 'every acct-cache key, and the identity marker, must go');
  assert.equal(boundAccountingCacheIdentity(), null);
  assert.equal(getTabCache(ROSTER), undefined);
});

test('the purge sweeps keys an older deploy wrote, not just known ones', () => {
  const s = newTab();
  bindAccountingCacheIdentity('kaner@simple.biz');
  s.setItem('acct-cache:some:retired-key:v1', JSON.stringify({ v: 1, id: 'x', at: 1, data: 1 }));
  clearAllAccountingCache();
  assert.equal(s.getItem('acct-cache:some:retired-key:v1'), null);
});

test('the purge does not touch keys belonging to other stores', () => {
  const s = newTab();
  bindAccountingCacheIdentity('kaner@simple.biz');
  s.setItem('emp-cache:employee:master-row', 'x');
  s.setItem('mgr-tab:manager:team-roster', 'y');
  setTabCache(ROSTER, [1]);

  clearAllAccountingCache();

  assert.equal(s.getItem('emp-cache:employee:master-row'), 'x');
  assert.equal(s.getItem('mgr-tab:manager:team-roster'), 'y');
});

// ── Class 2: identity ───────────────────────────────────────────────────────

test('another viewer’s entry never paints', () => {
  const s = newTab();
  bindAccountingCacheIdentity('first@simple.biz');
  setTabCache(ROSTER, [{ name: 'first' }]);

  reload(s);
  bindAccountingCacheIdentity('second@simple.biz');

  assert.equal(getTabCache(ROSTER), undefined);
  assert.equal(hasTabCache(ROSTER), false);
});

test('binding a different viewer purges the previous one’s bytes', () => {
  const s = newTab();
  bindAccountingCacheIdentity('first@simple.biz');
  setTabCache(ROSTER, [{ name: 'first' }]);
  setTabCache(QUEUE, [{ id: 1 }]);

  reload(s);
  bindAccountingCacheIdentity('second@simple.biz');

  const leftovers = Array.from({ length: s.length }, (_, i) => s.key(i)).filter(
    (k) => k !== 'acct-cache:@identity',
  );
  assert.deepEqual(leftovers, [], `first viewer's bytes survived the swap: ${leftovers.join(', ')}`);
});

test('a bind reconciles a stale marker left by a self-bind', () => {
  // The `?email=` path: the shell writes the new address to the session key, a
  // read self-binds to it WITHOUT consulting the marker, and only the explicit
  // bind can notice the marker still names someone else and drop their bytes.
  const s = newTab();
  bindAccountingCacheIdentity('first@simple.biz');
  setTabCache(ROSTER, [{ name: 'first' }]);

  reload(s);
  s.setItem(SESSION_EMAIL_KEY, 'second@simple.biz'); // ?email= override landed
  assert.equal(getTabCache(ROSTER), undefined, 'stamp mismatch already fails closed');
  assert.equal(s.getItem('acct-cache:@identity'), 'first@simple.biz', 'marker still stale');

  bindAccountingCacheIdentity('second@simple.biz');

  assert.equal(s.getItem('acct-cache:@identity'), 'second@simple.biz');
  assert.equal(s.getItem(`acct-cache:${ROSTER}`), null, 'the stale bytes must be gone');
});

test('an unresolved viewer is ignored, not treated as a sign-out', () => {
  // All three shells start with `viewerEmail === null` and fill it from an
  // effect. Purging on a falsy bind would wipe the cache on the first render of
  // every page load and defeat the mirror entirely.
  const s = newTab();
  bindAccountingCacheIdentity('kaner@simple.biz');
  setTabCache(ROSTER, [{ name: 'A' }]);

  bindAccountingCacheIdentity(null);
  bindAccountingCacheIdentity('');
  bindAccountingCacheIdentity(undefined);

  assert.deepEqual(getTabCache(ROSTER), [{ name: 'A' }]);
  assert.equal(boundAccountingCacheIdentity(), 'kaner@simple.biz');
  assert.ok(s.length > 0);
});

test('identity comparison is normalized, so casing is not a swap', () => {
  const s = newTab();
  bindAccountingCacheIdentity('Kaner@Simple.biz');
  setTabCache(ROSTER, [{ name: 'A' }]);
  reload(s);
  bindAccountingCacheIdentity('kaner@simple.biz');
  assert.deepEqual(getTabCache(ROSTER), [{ name: 'A' }], 'a case change must not purge');
});

// ── Class 3: schema drift ───────────────────────────────────────────────────

test('a blob from another schema version is treated as absent', () => {
  const s = newTab();
  bindAccountingCacheIdentity('kaner@simple.biz');
  s.setItem(
    `acct-cache:${ROSTER}`,
    JSON.stringify({ v: 999, id: 'kaner@simple.biz', at: Date.now(), data: [{ old: true }] }),
  );
  assert.equal(getTabCache(ROSTER), undefined);
});

test('a malformed or non-envelope blob is treated as absent, never thrown', () => {
  const s = newTab();
  bindAccountingCacheIdentity('kaner@simple.biz');
  for (const bad of ['not json at all', '[1,2,3]', 'null', '{"v":1}', '{"data":1}']) {
    s.setItem(`acct-cache:${ROSTER}`, bad);
    assert.equal(getTabCache(ROSTER), undefined, `should reject: ${bad}`);
  }
});

// ── Class 4: age ────────────────────────────────────────────────────────────

test('an entry past the 12h ceiling is evicted rather than painted', () => {
  const s = newTab();
  bindAccountingCacheIdentity('kaner@simple.biz');
  const thirteenHoursAgo = Date.now() - 13 * 60 * 60 * 1000;
  s.setItem(
    `acct-cache:${QUEUE}`,
    JSON.stringify({ v: 1, id: 'kaner@simple.biz', at: thirteenHoursAgo, data: [{ id: 1 }] }),
  );
  assert.equal(getTabCache(QUEUE), undefined, 'a lid closed Friday must not paint on Monday');
  assert.equal(s.getItem(`acct-cache:${QUEUE}`), null, 'and it should be swept, not left');
});

test('an entry inside the ceiling still paints, and reports its stamp', () => {
  const s = newTab();
  bindAccountingCacheIdentity('kaner@simple.biz');
  const anHourAgo = Date.now() - 60 * 60 * 1000;
  s.setItem(
    `acct-cache:${QUEUE}`,
    JSON.stringify({ v: 1, id: 'kaner@simple.biz', at: anHourAgo, data: [{ id: 1 }] }),
  );
  assert.deepEqual(getTabCache(QUEUE), [{ id: 1 }]);
  assert.equal(readTabCacheStamp(QUEUE), anHourAgo, 'the "as of" label reads the WRITE time');
});

// ── Class 5: the skip flag ──────────────────────────────────────────────────

test('clearing a key also clears its skip flag', () => {
  // A flag that outlived its data would report "already pulled" for a dataset
  // that has just been purged, and the pane that trusted it would stay empty.
  newTab();
  bindAccountingCacheIdentity('kaner@simple.biz');
  setTabCache(ROSTER, [1]);
  markFetchedThisSession(ROSTER);
  assert.ok(hasFetchedThisSession(ROSTER));

  clearTabCache(ROSTER);

  assert.equal(hasFetchedThisSession(ROSTER), false);
});

test('a full purge clears every skip flag', () => {
  newTab();
  bindAccountingCacheIdentity('kaner@simple.biz');
  markFetchedThisSession(ROSTER);
  markFetchedThisSession(QUEUE);

  clearAllAccountingCache();

  assert.equal(hasFetchedThisSession(ROSTER), false);
  assert.equal(hasFetchedThisSession(QUEUE), false);
});

test('the skip flag is confined to lookup lists and aggregate snapshots', async () => {
  // This store keeps `hasFetchedThisSession` — `payroll-wizard-notes.md:120`
  // documents the worker suggestions and the Hubstaff upload list as "fetched
  // once per page session" on purpose, and the CEO Overview snapshot is a heavy
  // company aggregate that re-pulls on reload.
  //
  // What it may NEVER gate is a per-person pay figure or a shared approval
  // queue: there a skipped fetch freezes one person's view of work somebody
  // else has already done — `manager-dashboard-cache.md`'s "two managers
  // approve the same request twice". This greps the call sites so the boundary
  // cannot be crossed by copy-paste.
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
    });

  // Datasets where a skipped refetch would freeze money or a queue others move.
  const banned = [
    'dispatchQueue',
    'peopleRoster',
    'transfers',
    'pabDisputes',
    'bankPreferredRequests',
    'ratesSummary',
    'overviewPayouts',
    'payrollReadiness',
    'payrollNotesOffboarded',
  ];

  const offenders: string[] = [];
  for (const file of walk(join(process.cwd(), 'src'))) {
    const src = readFileSync(file, 'utf8');
    if (!/hasFetchedThisSession/.test(src)) continue;
    for (const line of src.split('\n')) {
      if (!/hasFetchedThisSession|markFetchedThisSession/.test(line)) continue;
      for (const key of banned) {
        if (line.includes(`TAB_CACHE_KEYS.${key}`)) {
          offenders.push(`${file.replace(process.cwd(), '')}: ${line.trim()}`);
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `the skip flag may not gate a pay figure or a shared queue:\n${offenders.join('\n')}`,
  );
});

// ── Class 6: hostile storage ────────────────────────────────────────────────

test('a write that exceeds quota still serves this page load from memory', () => {
  const s = newTab();
  s.failWrites = true;
  bindAccountingCacheIdentity('kaner@simple.biz');
  setTabCache(ROSTER, [{ name: 'A' }]);
  assert.deepEqual(getTabCache(ROSTER), [{ name: 'A' }], 'memory copy must still answer');
});

test('no storage at all degrades to memory rather than throwing', () => {
  __resetAccountingCacheMemory();
  __setAccountingCacheStorage(null); // server-side / privacy mode
  assert.doesNotThrow(() => {
    bindAccountingCacheIdentity('kaner@simple.biz');
    setTabCache(ROSTER, [1]);
    getTabCache(ROSTER);
    clearAllAccountingCache();
  });
});

// ── Value semantics ─────────────────────────────────────────────────────────

test('null and [] are cached values; undefined is a miss', () => {
  newTab();
  bindAccountingCacheIdentity('kaner@simple.biz');

  setTabCache(ROSTER, null);
  assert.equal(getTabCache(ROSTER), null);
  assert.ok(hasTabCache(ROSTER));

  setTabCache(QUEUE, []);
  assert.deepEqual(getTabCache(QUEUE), []);
  assert.ok(hasTabCache(QUEUE));

  setTabCache(TAB_CACHE_KEYS.mesaNonMembers, undefined);
  assert.equal(hasTabCache(TAB_CACHE_KEYS.mesaNonMembers), false);
});

test('clearing one key leaves the others alone', () => {
  newTab();
  bindAccountingCacheIdentity('kaner@simple.biz');
  setTabCache(ROSTER, [1]);
  setTabCache(QUEUE, [2]);

  clearTabCache(ROSTER);

  assert.equal(getTabCache(ROSTER), undefined);
  assert.deepEqual(getTabCache(QUEUE), [2]);
});

/** `TAB_CACHE_KEYS` mixes plain string keys with per-week/per-status factories. */
type CacheKeyValue = (typeof TAB_CACHE_KEYS)[keyof typeof TAB_CACHE_KEYS];

const isFixedKey = (v: CacheKeyValue): v is Extract<CacheKeyValue, string> =>
  typeof v === 'string';

test('every fixed key is uniquely spelled', () => {
  const fixed = Object.values(TAB_CACHE_KEYS).filter(isFixedKey);
  assert.equal(new Set(fixed).size, fixed.length, `duplicate cache key: ${fixed.join(', ')}`);
});

test('no key collides with the identity marker', () => {
  const fixed = Object.values(TAB_CACHE_KEYS)
    .filter(isFixedKey)
    .map((v) => `acct-cache:${v}`);
  assert.ok(!fixed.includes('acct-cache:@identity'));
});
