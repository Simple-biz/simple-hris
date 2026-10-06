import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  __resetAccountingCacheMemory,
  __setAccountingCacheStorage,
  bindAccountingCacheIdentity,
  getTabCache,
  setTabCache,
  TAB_CACHE_KEYS,
} from '@/lib/accounting/tab-cache';
import {
  cacheableRoster,
  parseCachedBankChanges,
  parseCachedPeopleRoster,
  parseCachedPeopleStats,
  parseCachedPeopleWeeks,
  patchCachedPeopleRosterRows,
  readCachedBankChanges,
  readCachedPeopleRoster,
  readCachedPeopleStats,
  readCachedPeopleWeeks,
  STATS_TOOLTIP_LEADERS,
  toCachedPeopleStats,
  weeksFromSourceFilesAnswer,
  writeCachedBankChanges,
  writeCachedPeopleRoster,
  writeCachedPeopleStats,
  writeCachedPeopleWeeks,
} from './people-cache';
import type { PeopleRosterRow, PeopleSummary } from './people-roster';
import type { RailMix } from './rail-mix';

// The Accounting tab cache's envelope guarantees identity, schema version and
// age. It does NOT guarantee the shape inside, so these are the rules that stand
// between a stale or hand-edited blob and the People tab's paint.
// docs/features/accounting-dashboard-cache.md § People.

// ── Fixtures ────────────────────────────────────────────────────────────────

const railMix = (): RailMix => ({
  total: 3,
  routed: 2,
  unrouted: 1,
  rails: [
    { key: 'wires', label: 'Wires', count: 1, payable: 1, requires: 'bank + account', wallet: false },
    { key: 'hurupay', label: 'Kolan', count: 1, payable: 0, requires: 'wallet email', wallet: true },
  ],
  payable: 1,
  wallet: 1,
  bankRail: 1,
});

const summary = (): PeopleSummary => ({
  otEmployees: 1,
  otHours: 4.5,
  otPayoutPhp: 1200,
  otPayoutUsd: 21.4,
  railMix: railMix(),
  railMixByDept: { 'Lead Gen': railMix() },
});

const row = (name = 'Ana Cruz'): PeopleRosterRow => ({
  id: 'gml-1',
  employee_id: 'E-1',
  name,
  work_email: 'ana@simple.biz',
  personal_email: null,
  alternate_work_emails: ['ana2@simple.biz'],
  department: 'Lead Gen',
  start_date: '2026-01-05',
  street: null,
  city: 'Cebu',
  province: null,
  postal_code: null,
  full_address: null,
  phone_number: null,
  location: null,
  rate: { regular: 175, ot: 218.75, currency: 'PHP', source: 'employee' },
  hours: {
    thisWeek: 44.5, ot: 4.5, weekStart: '2026-09-27', weekEnd: '2026-10-03',
    inProgress: false, projectedHours: null, projectedOt: null,
  },
  processor: 'wires',
  hasBanking: true,
  accountLast4: '···1234',
  bankUpdatedAt: null,
});

const rosterEntry = () => ({
  rows: [row(), row('Ben Diaz')],
  summary: summary(),
  sourceFile: 'simple-biz_daily_report_2026-09-27_to_2026-10-03.csv',
  warning: null,
});

const leader = (n: number) => ({
  name: `P${n}`, email: `p${n}@simple.biz`, otHours: 10 - n, otPayoutPhp: 100 * n, otPayoutUsd: null, weeks: 1,
});
const dept = () => ({ department: 'Lead Gen', otHours: 9, otPayoutPhp: 900, otPayoutUsd: 16, people: 3 });
const point = (leaders: number) => ({
  sourceFile: 'w.csv', weekStart: '2026-09-27', weekEnd: '2026-10-03',
  otEmployees: leaders, otHours: 12, otPayoutPhp: 3000, otPayoutUsd: 53.5,
  leaders: Array.from({ length: leaders }, (_, i) => leader(i)),
  depts: [dept()],
});
const statsAnswer = () => ({
  daily: [point(8), point(2)],
  weekly: [point(12)],
  monthly: [point(30)],
  otLeaders: Array.from({ length: 30 }, (_, i) => leader(i)),
  otDepts: [dept()],
});

const change = (id = 'c1') => ({
  id,
  name: 'Ana Cruz',
  email: 'ana@simple.biz',
  fields: ['account_number'],
  changes: [{ field: 'account_number', before: '••••1111', after: '••••2222', changed: true }],
  processor: 'wise',
  createdNew: false,
  via: 'external_link',
  ip_address: '203.0.113.9',
  created_at: '2026-10-06T12:00:00Z',
});

/** Minimal in-memory Storage, the same shape tab-cache.test.ts uses. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
  } as Storage;
}

/** A brand-new browser tab, bound to one viewer. */
function newTab(): Storage {
  __resetAccountingCacheMemory();
  const s = fakeStorage();
  __setAccountingCacheStorage(s);
  bindAccountingCacheIdentity('kaner@simple.biz');
  return s;
}

/** A tab switch or reload: storage survives, module memory does not. */
function remount(s: Storage) {
  __resetAccountingCacheMemory();
  __setAccountingCacheStorage(s);
  bindAccountingCacheIdentity('kaner@simple.biz');
}

// ── Roster: one entry, fail closed ──────────────────────────────────────────

test('a well-formed roster entry survives a JSON round trip unchanged', () => {
  const entry = rosterEntry();
  assert.deepEqual(parseCachedPeopleRoster(JSON.parse(JSON.stringify(entry))), entry);
});

test('a non-object or bare-rows blob is a miss (the v1 `people:list` shape is never read back as an entry)', () => {
  for (const raw of [null, undefined, 'roster', 42, true, [row()]]) {
    assert.equal(parseCachedPeopleRoster(raw), null, `expected a miss for ${JSON.stringify(raw)}`);
  }
});

test('one malformed row rejects the whole roster entry, never a partial table', () => {
  const entry = rosterEntry();
  const broken = { ...entry, rows: [entry.rows[0], { ...entry.rows[1], hours: { thisWeek: 'forty' } }] };
  assert.equal(parseCachedPeopleRoster(broken), null);
});

test('a row field the table dereferences must have its real type', () => {
  const cases: Array<[string, unknown]> = [
    ['rate', null],
    ['hours', undefined],
    ['alternate_work_emails', null],
    ['hasBanking', 'yes'],
    ['name', 7],
  ];
  for (const [field, value] of cases) {
    const entry = rosterEntry();
    const bad = { ...entry, rows: [{ ...entry.rows[0], [field]: value }] };
    assert.equal(parseCachedPeopleRoster(bad), null, `${field} = ${String(value)} must reject`);
  }
  const e = rosterEntry();
  assert.equal(parseCachedPeopleRoster({ ...e, rows: [{ ...e.rows[0], rate: { ...e.rows[0].rate, currency: 'EUR' } }] }), null);
  assert.equal(parseCachedPeopleRoster({ ...e, rows: [{ ...e.rows[0], hours: { ...e.rows[0].hours, ot: Number.NaN } }] }), null);
});

test('the rows never travel without their summary: no summary, no entry', () => {
  const { summary: _drop, ...noSummary } = rosterEntry();
  void _drop;
  assert.equal(parseCachedPeopleRoster(noSummary), null);
  const s = summary();
  assert.equal(parseCachedPeopleRoster({ ...rosterEntry(), summary: { ...s, otEmployees: -1 } }), null);
  assert.equal(
    parseCachedPeopleRoster({ ...rosterEntry(), summary: { ...s, railMixByDept: { X: { ...railMix(), rails: 'none' } } } }),
    null,
  );
  // a rail slice that claims more payable than routed is not a rail mix
  const r = railMix();
  assert.equal(
    parseCachedPeopleRoster({ ...rosterEntry(), summary: { ...s, railMix: { ...r, rails: [{ ...r.rails[0], payable: 5 }] } } }),
    null,
  );
});

test('a failed roster read is never cacheable; a warning beside good rows is', () => {
  // /api/people answers 200 with `error` and NO rows when the roster read failed.
  assert.equal(cacheableRoster({ rows: [], error: 'Supabase down', summary: summary() }), null);
  assert.equal(cacheableRoster({ error: 'Supabase down' }), null);
  assert.equal(cacheableRoster({ rows: [row()] }), null, 'no summary to pair with');
  assert.deepEqual(cacheableRoster({ rows: [row()], summary: summary(), sourceFile: 'w.csv', error: 'history unavailable' }), {
    rows: [row()], summary: summary(), sourceFile: 'w.csv', warning: 'history unavailable',
  });
});

test('write → remount → read paints the same roster; a failed read leaves the good copy alone', () => {
  const s = newTab();
  const entry = rosterEntry();
  assert.equal(writeCachedPeopleRoster({ ...entry, error: null }), true);
  remount(s);
  assert.deepEqual(readCachedPeopleRoster(), entry);
  assert.equal(writeCachedPeopleRoster({ rows: [], summary: summary(), error: 'boom' }), false);
  remount(s);
  assert.deepEqual(readCachedPeopleRoster(), entry, 'the failure must not overwrite the last good read');
});

test('a profile save swaps the rows and keeps the summary and week they were read with', () => {
  newTab();
  const entry = rosterEntry();
  writeCachedPeopleRoster({ ...entry, error: null });
  const renamed = [row('Ana C. Cruz'), entry.rows[1]];
  patchCachedPeopleRosterRows(renamed);
  const after = readCachedPeopleRoster();
  assert.ok(after);
  assert.equal(after.rows[0].name, 'Ana C. Cruz');
  assert.deepEqual(after.summary, entry.summary);
  assert.equal(after.sourceFile, entry.sourceFile);
});

test('a profile save with nothing cached creates no entry (it has no summary to pair with)', () => {
  newTab();
  patchCachedPeopleRosterRows([row()]);
  assert.equal(getTabCache(TAB_CACHE_KEYS.peopleRoster), undefined);
});

test('a corrupt stored roster reads as nothing cached', () => {
  newTab();
  setTabCache(TAB_CACHE_KEYS.peopleRoster, [row()]); // the old bare-rows shape
  assert.equal(readCachedPeopleRoster(), null);
});

// ── Pay-week selector ───────────────────────────────────────────────────────

test('the week list derives exactly as the tab always has: current upload first, else the first file', () => {
  assert.deepEqual(
    weeksFromSourceFilesAnswer({
      uploads: [
        { source_file: 'a.csv', is_current: false },
        { source_file: 'b.csv', is_current: true },
        { source_file: null, is_current: false },
      ],
    }),
    { files: ['a.csv', 'b.csv'], defaultFile: 'b.csv' },
  );
  assert.deepEqual(weeksFromSourceFilesAnswer({ files: ['x.csv', 'y.csv'] }), { files: ['x.csv', 'y.csv'], defaultFile: 'x.csv' });
  assert.deepEqual(weeksFromSourceFilesAnswer({}), { files: [], defaultFile: '' });
});

test('an empty week list is never cached; a good one round-trips', () => {
  const s = newTab();
  writeCachedPeopleWeeks({ files: [], defaultFile: '' });
  assert.equal(readCachedPeopleWeeks(), null);
  writeCachedPeopleWeeks({ files: ['a.csv', 'b.csv'], defaultFile: 'b.csv' });
  remount(s);
  assert.deepEqual(readCachedPeopleWeeks(), { files: ['a.csv', 'b.csv'], defaultFile: 'b.csv' });
  assert.equal(parseCachedPeopleWeeks({ files: ['a.csv', ''], defaultFile: 'a.csv' }), null);
  assert.equal(parseCachedPeopleWeeks({ files: ['a.csv'], defaultFile: 3 }), null);
});

// ── Statistics ──────────────────────────────────────────────────────────────

test('the cached Statistics keep each point’s tooltip leaders and nothing else is cut', () => {
  const answer = statsAnswer();
  const cached = toCachedPeopleStats(answer);
  for (const series of ['daily', 'weekly', 'monthly'] as const) {
    cached[series].forEach((p, i) => {
      const live = answer[series][i];
      assert.deepEqual(p.leaders, live.leaders.slice(0, STATS_TOOLTIP_LEADERS), `${series}[${i}] keeps the tooltip's top five`);
      assert.deepEqual({ ...p, leaders: [] }, { ...live, leaders: [] }, `${series}[${i}] keeps every other field`);
    });
  }
  assert.equal(cached.otLeaders.length, 30, 'the standings leaderboard is never trimmed');
  assert.deepEqual(cached.otDepts, answer.otDepts);
  assert.equal(answer.weekly[0].leaders.length, 12, 'the live answer is not mutated');
});

test('the tooltip renders its leaders through the same constant the cache trims to', () => {
  // If the tooltip ever showed more than the cache keeps, a cached paint would
  // show fewer names than the live one. One constant makes that impossible.
  const src = readFileSync(join(process.cwd(), 'src/components/people/PeopleTab.tsx'), 'utf8');
  assert.match(src, /leaders \?\? \[\]\)\.slice\(0, STATS_TOOLTIP_LEADERS\)/);
  assert.doesNotMatch(src, /leaders \?\? \[\]\)\.slice\(0, \d+\)/);
});

test('Statistics write → remount → read; a point carrying more than the tooltip shows is rejected', () => {
  const s = newTab();
  writeCachedPeopleStats(statsAnswer());
  remount(s);
  const read = readCachedPeopleStats();
  assert.ok(read);
  assert.deepEqual(read, toCachedPeopleStats(statsAnswer()));
  // An untrimmed answer is not what this store writes; reading one back means
  // something else wrote the key.
  assert.equal(parseCachedPeopleStats(statsAnswer()), null);
  assert.equal(parseCachedPeopleStats({ ...toCachedPeopleStats(statsAnswer()), otDepts: [{ department: 'X' }] }), null);
  assert.equal(parseCachedPeopleStats(null), null);
});

// ── Bank changes ────────────────────────────────────────────────────────────

test('the Bank changes feed round-trips with its write time, and one bad row rejects it', () => {
  const s = newTab();
  writeCachedBankChanges([change('c1'), change('c2')]);
  remount(s);
  const read = readCachedBankChanges();
  assert.ok(read);
  assert.deepEqual(read.rows, [change('c1'), change('c2')]);
  assert.equal(typeof read.syncedAt, 'number');
  assert.equal(parseCachedBankChanges([change(), { ...change('c3'), fields: 'account_number' }]), null);
  assert.equal(parseCachedBankChanges([{ ...change(), id: '' }]), null);
  assert.equal(parseCachedBankChanges([{ ...change(), changes: [{ field: 'x', before: 1, after: null, changed: true }] }]), null);
  assert.equal(parseCachedBankChanges({ rows: [] }), null);
});

// ── One write path ──────────────────────────────────────────────────────────

test('nothing under src/components/people writes or reads the store directly', () => {
  // Every People read and write goes through people-cache.ts, where the
  // validation and the "never cache a failed read" rules live. A direct
  // setTabCache in a component is how a failed answer or an untrimmed 3.2M
  // character Statistics payload would reach sessionStorage.
  const dir = join(process.cwd(), 'src/components/people');
  const offenders: string[] = [];
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((e) => {
      const full = join(d, e);
      return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(e) ? [full] : [];
    });
  for (const file of walk(dir)) {
    const src = readFileSync(file, 'utf8');
    if (/\b(setTabCache|getTabCache|TAB_CACHE_KEYS)\b/.test(src)) offenders.push(file.replace(process.cwd(), ''));
  }
  assert.deepEqual(offenders, []);
});
