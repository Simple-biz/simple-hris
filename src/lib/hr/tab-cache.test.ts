import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FRESH_WINDOW_MS,
  HR_TAB_CACHE_KEYS,
  hrFpuEnrollmentsKey,
  hrFpuGroupsKey,
  hrHiringRecruitersKey,
  hrHiringSourcesKey,
  hrPaintCache,
  hrReferralsKey,
  hrViewerNameKey,
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

// ── the FPU per-class keys (2026-09-17) ─────────────────────────────────────

test('each FPU class gets its own key, so switching classes does not evict the other', () => {
  const a = hrFpuEnrollmentsKey('class-a');
  const b = hrFpuEnrollmentsKey('class-b');
  assert.notEqual(a, b);
  __resetHrTabCache();
  setHrTabCache(a, ['rowA']);
  setHrTabCache(b, ['rowB']);
  assert.deepEqual(getHrTabCache(a), ['rowA']);
  assert.deepEqual(getHrTabCache(b), ['rowB'], 'the second class evicted the first');
});

test('enrollments and groups for the SAME class never collide', () => {
  assert.notEqual(hrFpuEnrollmentsKey('c1'), hrFpuGroupsKey('c1'));
});

test('the FPU keys are namespaced under hr:, like every other entry', () => {
  for (const k of [hrFpuEnrollmentsKey('c1'), hrFpuGroupsKey('c1'), HR_TAB_CACHE_KEYS.fpuClasses, HR_TAB_CACHE_KEYS.mesaEligible]) {
    assert.match(k, /^hr:/);
  }
});

test('a per-class key obeys the same freshness window as a fixed one', () => {
  __resetHrTabCache();
  const k = hrFpuGroupsKey('c1');
  assert.equal(hasHrTabCache(k), false);
  assert.equal(isHrTabCacheFresh(k), false, 'a cold entry must never skip the fetch');
  setHrTabCache(k, { groups: [] });
  assert.equal(hasHrTabCache(k), true);
  assert.equal(isHrTabCacheFresh(k), true);
  // Past the window it still PAINTS but no longer SKIPS — the distinction this
  // store exists to keep.
  const past = (readHrTabCacheStamp(k) ?? 0) + FRESH_WINDOW_MS + 1;
  assert.equal(isHrTabCacheFresh(k, past), false);
  assert.equal(hasHrTabCache(k), true, 'a stale entry must still paint');
});

// ── the 2026-10-01 sweep: every HR tab that still loaded cold ───────────────

test('the shared-panel adapter writes into the HR store itself, not a copy', () => {
  // Leaves / Announcements / S-Wall / Notifications paint from this. If it were
  // a second Map, a sign-out would drop one and not the other.
  __resetHrTabCache();
  hrPaintCache.set(HR_TAB_CACHE_KEYS.leaves, [{ id: 'l1' }]);
  assert.deepEqual(getHrTabCache(HR_TAB_CACHE_KEYS.leaves), [{ id: 'l1' }]);
  assert.ok(hasHrTabCache(HR_TAB_CACHE_KEYS.leaves));
  setHrTabCache(HR_TAB_CACHE_KEYS.swall, { posts: [] });
  assert.ok(hrPaintCache.has(HR_TAB_CACHE_KEYS.swall));
  assert.deepEqual(hrPaintCache.get(HR_TAB_CACHE_KEYS.swall), { posts: [] });
});

test('the shared-panel adapter exposes NO freshness predicate, so a shared panel can never skip', () => {
  // Announcements and S-Wall see a new post only through Realtime (dead here)
  // or a refetch, and Notifications must agree with the live chime + badge.
  // A skip window handed to them would hide a post you just made.
  assert.deepEqual(Object.keys(hrPaintCache).sort(), ['get', 'has', 'set']);
});

test('each hiring week gets its own entry, and All time is its own entry too', () => {
  const weekA = hrHiringSourcesKey('2026-09-27');
  const weekB = hrHiringSourcesKey('2026-10-04');
  const all = hrHiringSourcesKey(null);
  assert.equal(new Set([weekA, weekB, all]).size, 3);
  __resetHrTabCache();
  setHrTabCache(weekA, { sources: [], total: 1 });
  setHrTabCache(weekB, { sources: [], total: 2 });
  assert.deepEqual(getHrTabCache(weekA), { sources: [], total: 1 }, 'the second week evicted the first');
});

test('sources, recruiters and referrals for the SAME week never collide', () => {
  const w = '2026-09-27';
  const keys = [hrHiringSourcesKey(w), hrHiringRecruitersKey(w), hrReferralsKey(w)];
  assert.equal(new Set(keys).size, keys.length);
  const allTime = [hrHiringSourcesKey(null), hrHiringRecruitersKey(null), hrReferralsKey(null)];
  assert.equal(new Set(allTime).size, allTime.length);
});

test('the all-time sources entry is ONE key, shared by the Overview card and the checklist', () => {
  // Both read the all-time /sources payload. Two spellings would mean two
  // fetches and two answers that can disagree.
  assert.equal(hrHiringSourcesKey(null), hrHiringSourcesKey(null));
  assert.equal(hrHiringSourcesKey(null), 'hr:hiring-sources:all');
});

test('the greeting name is keyed per viewer, case-insensitively', () => {
  assert.notEqual(hrViewerNameKey('a@simple.biz'), hrViewerNameKey('b@simple.biz'));
  assert.equal(hrViewerNameKey(' A@Simple.biz '), hrViewerNameKey('a@simple.biz'));
});

test('every new key is namespaced under hr:', () => {
  for (const k of [
    hrViewerNameKey('a@simple.biz'),
    hrHiringSourcesKey('2026-09-27'),
    hrHiringRecruitersKey(null),
    hrReferralsKey('2026-09-27'),
    HR_TAB_CACHE_KEYS.newHireChecklistPeriods,
    HR_TAB_CACHE_KEYS.departments,
    HR_TAB_CACHE_KEYS.masterListNames,
    HR_TAB_CACHE_KEYS.workspaceLicenseInfo,
    HR_TAB_CACHE_KEYS.leaves,
    HR_TAB_CACHE_KEYS.announcements,
    HR_TAB_CACHE_KEYS.swall,
    HR_TAB_CACHE_KEYS.notifications,
  ]) {
    assert.match(k, /^hr:/);
  }
});

test('no key is spelled after presence, a signed URL or a bank field', () => {
  // The factory's never-cache list (create-tab-cache.ts): presence is a WRONG
  // answer when stale, a signed URL expires, and bank fields stay out entirely.
  // GML last-seen, the dispatch lock and the Leaves delete permission are live
  // reads for the same reason and are deliberately absent from this map.
  for (const k of Object.values(HR_TAB_CACHE_KEYS)) {
    assert.doesNotMatch(k, /presence|last-seen|signed|bank|account-number|routing|lock|permission/i, k);
  }
});
