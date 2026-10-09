/**
 * Run: node --import tsx --test src/lib/accounting-scoreboard/tab-cache.test.ts
 *
 * The scoreboard's browser cache (tab-cache.ts) on the shared envelope. The envelope's own suite
 * (dashboard-cache/create-tab-cache.test.ts) proves the identity, age, schema and quota rules; this
 * pins what THIS store adds: the viewer (a permission) is never cached, a board is keyed by its own
 * week and never paints as another week, only the newest MAX_CACHED_WEEKS boards are kept, and
 * nothing it exports can answer "already fetched". For the Tasks views it also pins: no viewer, a view only
 * paints as itself, never on another Eastern day, and never for a role that may not see it.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as store from './tab-cache';
import {
  MAX_CACHED_TASK_VIEWS,
  MAX_CACHED_WEEKS,
  SCOREBOARD_CACHE_KEYS,
  bindScoreboardCache,
  clearCachedKeys,
  clearCachedRoleGrants,
  clearCachedTasks,
  readCachedBoard,
  readCachedHistory,
  readCachedKeys,
  readCachedRoleGrants,
  readCachedRoster,
  readCachedTasks,
  scoreboardTabCache,
  writeCachedBoard,
  writeCachedHistory,
  writeCachedKeys,
  writeCachedRoleGrants,
  writeCachedRoster,
  writeCachedTasks,
} from './tab-cache';
import type { BoardPayload, KeysPayload, RoleGrant, TasksPayload } from './types';

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
    viewer: { email: 'carla@simple.biz', role: 'admin' },
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
  assert.equal('viewer' in cached, false, 'viewer.role decides Setup and deletes: it comes from the page, never the cache');
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

// ── Tasks views ──────────────────────────────────────────────────────────────

const TODAY = '2026-10-08';

function tasks(view: TasksPayload['view'], over: Partial<TasksPayload> = {}): TasksPayload {
  return {
    today: TODAY,
    viewer: { email: 'carla@simple.biz', role: 'admin' },
    view,
    people: [{ email: 'joana@simple.biz', name: 'Joana' }],
    tasks: [{ id: 't1', ownerEmail: 'joana@simple.biz', title: 'Check the inbox', frequency: 'daily', sortOrder: 0, createdAt: '2026-10-08T12:00:00Z' }],
    checks: [{ taskId: 't1', periodKey: TODAY, checkedBy: 'joana@simple.biz', checkedAt: '2026-10-08T13:00:00Z' }],
    teamProgress: null,
    chatConfigured: true,
    ...over,
  };
}
const MINE: TasksPayload['view'] = { kind: 'person', person: { email: 'carla@simple.biz', name: 'Carla' }, own: true };
const JOANA: TasksPayload['view'] = { kind: 'person', person: { email: 'joana@simple.biz', name: 'Joana' }, own: false };

test('a Tasks view round-trips under its own key, WITHOUT the viewer, and never inside a board blob', () => {
  bindScoreboardCache('carla@simple.biz');
  writeCachedTasks('me', tasks(MINE));
  const cached = readCachedTasks('me', TODAY, 'admin');
  assert.ok(cached);
  assert.equal('viewer' in cached, false, 'the role is a permission: it comes from the page, never the cache');
  assert.equal(cached.checks.length, 1);
  writeCachedBoard(board('2026-10-04'));
  assert.equal('tasks' in (readCachedBoard('2026-10-04') ?? {}), false, 'the board blob never carries tasks');
});

test('a view paints only as itself: me is own, all is Everyone, an email is that person', () => {
  bindScoreboardCache('carla@simple.biz');
  writeCachedTasks('all', tasks({ kind: 'all' }));
  writeCachedTasks('joana@simple.biz', tasks(JOANA));
  assert.ok(readCachedTasks('all', TODAY, 'admin'));
  assert.ok(readCachedTasks('joana@simple.biz', TODAY, 'admin'));
  writeCachedTasks('me', tasks(JOANA));
  assert.equal(readCachedTasks('me', TODAY, 'admin'), undefined, "someone else's board is never written as mine");
  scoreboardTabCache.set(SCOREBOARD_CACHE_KEYS.tasks('all'), { ...tasks(MINE), viewer: undefined });
  assert.equal(readCachedTasks('all', TODAY, 'admin'), undefined, 'a blob filed under the wrong view is refused');
});

test("someone else's board, or Everyone, never paints for a role that may not see it NOW", () => {
  bindScoreboardCache('carla@simple.biz');
  writeCachedTasks('all', tasks({ kind: 'all' }));
  writeCachedTasks('joana@simple.biz', tasks(JOANA));
  writeCachedTasks('me', tasks(MINE));
  for (const view of ['all', 'joana@simple.biz']) {
    assert.ok(readCachedTasks(view, TODAY, 'assistant'), `${view}: an Assistant sees everyone's`);
    assert.equal(readCachedTasks(view, TODAY, 'member'), undefined, `${view}: demoted to Team member, it never paints`);
  }
  assert.ok(readCachedTasks('me', TODAY, 'member'), 'your own board paints for every role');
});

test("a view read on another Eastern day never paints: its ticks are another period's", () => {
  bindScoreboardCache('carla@simple.biz');
  writeCachedTasks('me', tasks(MINE, { today: '2026-10-07' }));
  assert.equal(readCachedTasks('me', TODAY, 'admin'), undefined, "yesterday's daily ticks would paint as done today");
  assert.ok(readCachedTasks('me', '2026-10-07', 'admin'));
});

test('inert until bound; another viewer never reads a view; a refused view is forgotten', () => {
  writeCachedTasks('me', tasks(MINE));
  bindScoreboardCache('carla@simple.biz');
  assert.equal(readCachedTasks('me', TODAY, 'admin'), undefined, 'a write before binding is dropped');
  writeCachedTasks('me', tasks(MINE));
  bindScoreboardCache('someone.else@simple.biz');
  assert.equal(readCachedTasks('me', TODAY, 'admin'), undefined, 'binding a different viewer purges first');

  bindScoreboardCache('carla@simple.biz');
  writeCachedTasks('all', tasks({ kind: 'all' }));
  clearCachedTasks('all');
  assert.equal(readCachedTasks('all', TODAY, 'admin'), undefined);
  assert.deepEqual(scoreboardTabCache.get<string[]>(SCOREBOARD_CACHE_KEYS.taskViews), []);
});

test(`only the newest ${MAX_CACHED_TASK_VIEWS} Tasks views are kept`, () => {
  bindScoreboardCache('carla@simple.biz');
  const emails = Array.from({ length: MAX_CACHED_TASK_VIEWS + 1 }, (_, i) => `p${i}@simple.biz`);
  for (const email of emails) {
    writeCachedTasks(email, tasks({ kind: 'person', person: { email, name: email }, own: false }));
  }
  assert.equal(readCachedTasks(emails[0], TODAY, 'admin'), undefined, 'the oldest-written view was dropped');
  for (const email of emails.slice(1)) assert.ok(readCachedTasks(email, TODAY, 'admin'), email);
  assert.equal(scoreboardTabCache.get<string[]>(SCOREBOARD_CACHE_KEYS.taskViews)?.length, MAX_CACHED_TASK_VIEWS);
});

// ── Setup → Keys and Setup → Access (2026-10-09) ─────────────────────────────

const KEYS: KeysPayload = {
  viewer: { email: 'carla@simple.biz', role: 'admin' },
  keys: [{ id: 'k1', label: 'QBO', createdBy: 'carla@simple.biz', createdAt: '2026-10-09T12:00:00Z', archived: false }],
  seats: [{ id: 's1', keyId: 'k1', email: 'joana@simple.biz', givenBy: 'carla@simple.biz', givenAt: '2026-10-09T12:00:00Z', removedBy: null, removedAt: null }],
  people: [{ email: 'joana@simple.biz', name: 'Joana' }],
};
const GRANTS: RoleGrant[] = [{ email: 'claire@simple.biz', role: 'admin', grantedBy: 'migration', grantedAt: '2026-10-08T12:00:00Z' }];

test('Keys round-trip WITHOUT the viewer, and paint only for a role that may see Keys now', () => {
  bindScoreboardCache('carla@simple.biz');
  writeCachedKeys(KEYS);
  const raw = scoreboardTabCache.get<Record<string, unknown>>(SCOREBOARD_CACHE_KEYS.keys);
  assert.ok(raw && !('viewer' in raw), 'the viewer (a permission) is never cached');
  assert.deepEqual(readCachedKeys('admin')?.seats, KEYS.seats);
  assert.equal(readCachedKeys('assistant'), undefined, 'an Assistant never sees Keys, cached or not');
  assert.equal(readCachedKeys('member'), undefined);
});

test('Keys: inert until bound, another viewer purges, a refusal forgets, a malformed blob is a miss', () => {
  writeCachedKeys(KEYS);
  bindScoreboardCache('carla@simple.biz');
  assert.equal(readCachedKeys('admin'), undefined, 'a write before binding is dropped');
  writeCachedKeys(KEYS);
  bindScoreboardCache('someone.else@simple.biz');
  assert.equal(readCachedKeys('admin'), undefined, 'binding a different viewer purges first');
  bindScoreboardCache('carla@simple.biz');
  writeCachedKeys(KEYS);
  clearCachedKeys();
  assert.equal(readCachedKeys('admin'), undefined);
  scoreboardTabCache.set(SCOREBOARD_CACHE_KEYS.keys, { keys: [], seats: 'nope', people: [] });
  assert.equal(readCachedKeys('admin'), undefined, 'fails closed on a malformed blob');
});

test('Access grants round-trip, paint only for manage_roles now, and a refusal forgets them', () => {
  bindScoreboardCache('carla@simple.biz');
  writeCachedRoleGrants(GRANTS);
  assert.deepEqual(readCachedRoleGrants('admin'), GRANTS);
  assert.equal(readCachedRoleGrants('assistant'), undefined);
  clearCachedRoleGrants();
  assert.equal(readCachedRoleGrants('admin'), undefined);
  assert.deepEqual(readCachedRoleGrants('admin') ?? [], [], 'nothing cached is a miss, never an empty list painted as real');
});

test('History: inert until bound, round-trips for its viewer, another viewer purges, a malformed blob is a miss', () => {
  const HISTORY = {
    thisWeek: '2026-10-04',
    firstWeek: '2024-12-29',
    sectionIds: ['buckets'],
    weeks: [{ weekStart: '2026-09-27', partial: false, team: { score: 90, light: 'green' as const }, cells: {} }],
  };
  writeCachedHistory(HISTORY);
  bindScoreboardCache('carla@simple.biz');
  assert.equal(readCachedHistory(), undefined, 'a write before binding is dropped');
  writeCachedHistory(HISTORY);
  assert.deepEqual(readCachedHistory(), HISTORY);
  bindScoreboardCache('someone.else@simple.biz');
  assert.equal(readCachedHistory(), undefined, 'binding a different viewer purges first');
  scoreboardTabCache.set(SCOREBOARD_CACHE_KEYS.history, { thisWeek: '2026-10-04', sectionIds: [], weeks: 'nope' });
  assert.equal(readCachedHistory(), undefined, 'fails closed on a malformed blob');
});
