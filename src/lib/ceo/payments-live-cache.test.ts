import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCachedPaymentsLive, toCachedPaymentsLive } from './payments-live-cache';

const live = {
  sourceFile: 'hubstaff_2026-09-27_to_2026-10-03.csv',
  label: 'September 27 - October 3, 2026',
  total: 412,
  paid: 300,
  remaining: 112,
  departments: [{ key: 'lead-gen', name: 'Lead Gen', total: 200, paid: 150 }],
  // The per-person "being paid now" feed. It must never reach the cache.
  recent: [
    {
      email: 'jane.doe@simple.biz',
      name: 'Jane Doe',
      amountUsd: 123.45,
      amountPhp: 7000,
      amountCop: null,
      paidAt: '2026-10-02T03:00:00.000Z',
    },
  ],
  recentHydrated: true,
  loading: false,
  error: null,
};

// ── Class 1: a per-person pay figure reaches storage ────────────────────────

test('the cached value never carries the per-person recent feed', () => {
  const cached = toCachedPaymentsLive(live);
  const json = JSON.stringify(cached);
  assert.ok(!('recent' in cached), 'no `recent` key');
  assert.ok(!json.includes('jane.doe@simple.biz'), 'no paid person email');
  assert.ok(!json.includes('123.45'), 'no paid amount');
  assert.deepEqual(Object.keys(cached).sort(), [
    'departments', 'label', 'paid', 'remaining', 'sourceFile', 'total',
  ]);
});

test('a department row is copied field by field, so an extra field cannot ride along', () => {
  const cached = toCachedPaymentsLive({
    ...live,
    departments: [{ key: 'k', name: 'N', total: 2, paid: 1, ...{ workers: ['a@simple.biz'] } }],
  });
  assert.deepEqual(cached.departments, [{ key: 'k', name: 'N', total: 2, paid: 1 }]);
});

// ── Class 2: a malformed or foreign entry paints ────────────────────────────

test('a well-formed entry round-trips through JSON', () => {
  const back = parseCachedPaymentsLive(JSON.parse(JSON.stringify(toCachedPaymentsLive(live))));
  assert.deepEqual(back, toCachedPaymentsLive(live));
});

test('anything malformed reads as nothing cached', () => {
  const good = toCachedPaymentsLive(live);
  const cases: unknown[] = [
    undefined,
    null,
    'x',
    [],
    { ...good, label: '' },
    { ...good, label: 7 },
    { ...good, sourceFile: 3 },
    { ...good, total: -1 },
    { ...good, paid: 1.5 },
    { ...good, remaining: Number.NaN },
    { ...good, remaining: '4' },
    { ...good, departments: 'Lead Gen' },
    { ...good, departments: [{ key: 'k', name: 'N', total: 1 }] },
    { ...good, departments: [good.departments[0], null] },
  ];
  for (const c of cases) assert.equal(parseCachedPaymentsLive(c), null, JSON.stringify(c));
});

test('a null sourceFile is a valid cycle-less snapshot', () => {
  const back = parseCachedPaymentsLive({ ...toCachedPaymentsLive(live), sourceFile: null });
  assert.equal(back?.sourceFile, null);
});

// ── Class 3: the hook seeds or restamps the wrong thing ─────────────────────

test('the hook seeds recentHydrated false and only writes when real data arrives', () => {
  const src = readFileSync(join(process.cwd(), 'src/hooks/usePaymentsLive.ts'), 'utf8');
  // The seed may paint the counters but never claim the feed was hydrated, and
  // never carry a cached `recent`.
  const seed = src.slice(src.indexOf('function seedFromCache'), src.indexOf('\n}\n', src.indexOf('function seedFromCache')));
  assert.ok(seed.length > 0, 'seedFromCache exists');
  assert.match(seed, /parseCachedPaymentsLive\(/, 'the seed goes through the parser');
  assert.match(seed, /recent: \[\],\s*recentHydrated: false,/);
  assert.match(src, /useState<PaymentsLiveState>\(seedFromCache\)/);
  // Writes go through the allow-list, never the raw state.
  assert.ok(!/setTabCache\([^)]*,\s*state\)/.test(src), 'never cache the raw state');
  assert.match(src, /setTabCache\(TAB_CACHE_KEYS\.ceoPaymentsLive, toCachedPaymentsLive\(/);
  // The write effect is gated on a revision that only real arrivals bump, so a
  // mount never restamps the seed (memory hr-cache-freshness-window).
  assert.match(src, /if \(cacheRev === 0\) return;/);
  // A paint-only key: the skip flag may never gate it.
  assert.ok(!/hasFetchedThisSession/.test(src));
});
