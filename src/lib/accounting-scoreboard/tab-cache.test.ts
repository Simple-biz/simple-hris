/**
 * Run: node --import tsx --test src/lib/accounting-scoreboard/tab-cache.test.ts
 *
 * The scoreboard's browser cache (tab-cache.ts) on the shared envelope. The envelope's own suite
 * (dashboard-cache/create-tab-cache.test.ts) proves the identity, age, schema and quota rules; this
 * pins what THIS store adds: the viewer (a permission) is never cached, a board is keyed by its own
 * week and never paints as another week, only the newest MAX_CACHED_WEEKS boards are kept, and
 * nothing it exports can answer "already fetched".
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as store from './tab-cache';
import {
  MAX_CACHED_WEEKS,
  SCOREBOARD_CACHE_KEYS,
  bindScoreboardCache,
  readCachedBoard,
  readCachedRoster,
  scoreboardTabCache,
  writeCachedBoard,
  writeCachedRoster,
} from './tab-cache';
import type { BoardPayload } from './types';

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

function board(weekStart: string, over: Partial<BoardPayload> = {}): BoardPayload {
  return {
    weekStart,
    lastWeekStart: weekStart,
    today: '2026-10-06',
    viewer: { email: 'carla@simple.biz', isManager: true },
    settings: [],
    customSections: [],
    rows: [],
    entries: [{ rowId: 'r', date: weekStart, slot: 'am', value: 3 }],
    collections: [],
    problems: [],
    problemTypes: [],
    lastMeetingDate: null,
    history: { allTimeByRow: {}, record: null, liveSince: null },
    members: [],
    bonus: { ok: false, reason: 'test' },
    payrollEvents: [],
    firstClosedPeriodEnd: null,
    generatedAt: '2026-10-06T12:00:00Z',
    ...over,
  };
}

beforeEach(() => {
  scoreboardTabCache.__resetMemory();
  scoreboardTabCache.__setStorage(fakeStorage());
});

test('a board round-trips under its own week, WITHOUT the viewer (a permission is never cached)', () => {
  bindScoreboardCache('carla@simple.biz');
  writeCachedBoard(board('2026-10-04'));
  const cached = readCachedBoard('2026-10-04');
  assert.ok(cached);
  assert.equal(cached.weekStart, '2026-10-04');
  assert.deepEqual(cached.entries, [{ rowId: 'r', date: '2026-10-04', slot: 'am', value: 3 }]);
  assert.equal('viewer' in cached, false, 'isManager decides Setup and deletes: it comes from the page, never the cache');
  assert.equal(readCachedBoard('2026-09-27'), undefined, 'another week is a miss, never this one');
});

test('inert until bound, and another viewer on the same tab never reads the board', () => {
  writeCachedBoard(board('2026-10-04'));
  bindScoreboardCache('carla@simple.biz');
  assert.equal(readCachedBoard('2026-10-04'), undefined, 'a write before binding is dropped');

  writeCachedBoard(board('2026-10-04'));
  bindScoreboardCache('someone.else@simple.biz');
  assert.equal(readCachedBoard('2026-10-04'), undefined, 'binding a different viewer purges first');
  bindScoreboardCache('carla@simple.biz');
  assert.equal(readCachedBoard('2026-10-04'), undefined, 'and the purge is real, not hidden');
});

test('a blob filed under the wrong week is refused (it would paint one week as another)', () => {
  bindScoreboardCache('carla@simple.biz');
  scoreboardTabCache.set(SCOREBOARD_CACHE_KEYS.board('2026-10-04'), { ...board('2026-09-27') });
  assert.equal(readCachedBoard('2026-10-04'), undefined);
});

test(`only the newest ${MAX_CACHED_WEEKS} weeks are kept; re-writing a week makes it newest again`, () => {
  bindScoreboardCache('carla@simple.biz');
  const weeks = ['2026-09-06', '2026-09-13', '2026-09-20', '2026-09-27', '2026-10-04'];
  for (const w of weeks) writeCachedBoard(board(w));
  assert.equal(readCachedBoard('2026-09-06'), undefined, 'the oldest-written week was dropped');
  for (const w of weeks.slice(1)) assert.ok(readCachedBoard(w), w);

  writeCachedBoard(board('2026-09-13')); // stepped back to it: newest again
  writeCachedBoard(board('2026-08-30'));
  assert.ok(readCachedBoard('2026-09-13'), 'kept: it was written again');
  assert.equal(readCachedBoard('2026-09-20'), undefined, 'the oldest-written week goes instead');
  assert.equal(scoreboardTabCache.get<string[]>(SCOREBOARD_CACHE_KEYS.weeks)?.length, MAX_CACHED_WEEKS);
});

test('the roster picker round-trips; nothing cached is a miss, not an empty roster', () => {
  bindScoreboardCache('carla@simple.biz');
  assert.equal(readCachedRoster(), undefined);
  writeCachedRoster([{ name: 'Galang, April Pearl "April"', department: 'Accounting Team', workEmail: 'aprilg@simple.biz' }]);
  assert.equal(readCachedRoster()?.[0].workEmail, 'aprilg@simple.biz');
});

test('nothing this store exports can answer "already fetched": a cached value paints, never decides', () => {
  for (const name of Object.keys(store)) assert.doesNotMatch(name, /fetched|fresh|skip|stale/i, name);
});
