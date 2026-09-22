import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFirstHoursIndex,
  classifyFirstPaycheck,
  earliestWeekForAliases,
  weekKeyFromUploadName,
  type FirstHoursIndex,
} from './first-paycheck';

const idx = (entries: Array<[string, string]>, oldestWeek: string | null): FirstHoursIndex => ({
  firstWeekByEmail: new Map(entries),
  oldestWeek,
});

// ── The case this exists for ─────────────────────────────────────────────────

test('a one-week hire: first hours this week AND in the final-pay overlay → first + alsoLeaving', () => {
  const index = idx([['newbie@simple.biz', '2026-09-13']], '2026-03-01');
  const v = classifyFirstPaycheck({
    weekStart: '2026-09-13',
    aliases: ['newbie@simple.biz'],
    index,
    alsoLeaving: true,
    startDate: '2026-09-15',
  });
  assert.deepEqual(v, { kind: 'first', firstWeek: '2026-09-13', alsoLeaving: true, startDate: '2026-09-15' });
});

test('a first paycheck with NO start date on file is still first — the date is detail, never the criterion', () => {
  const index = idx([['newbie@simple.biz', '2026-09-13']], '2026-03-01');
  const v = classifyFirstPaycheck({ weekStart: '2026-09-13', aliases: ['newbie@simple.biz'], index, alsoLeaving: false });
  assert.equal(v.kind, 'first');
  if (v.kind === 'first') assert.equal(v.startDate, null);
});

// ── Not first ────────────────────────────────────────────────────────────────

test('hours in an earlier upload → not_first, naming the first week', () => {
  const index = idx([['vet@simple.biz', '2026-05-03']], '2026-03-01');
  const v = classifyFirstPaycheck({ weekStart: '2026-09-13', aliases: ['vet@simple.biz'], index, alsoLeaving: true });
  assert.deepEqual(v, { kind: 'not_first', firstWeek: '2026-05-03' });
});

test('an alias bridges history: Hubstaff address is new, but the master work email has old hours → not_first', () => {
  // master cathyp@ vs Hubstaff cathypa@ — the known alias split.
  const index = idx([['cathyp@simple.biz', '2026-04-05'], ['cathypa@simple.biz', '2026-09-13']], '2026-03-01');
  const v = classifyFirstPaycheck({
    weekStart: '2026-09-13',
    aliases: ['cathypa@simple.biz', 'cathyp@simple.biz'],
    index,
    alsoLeaving: false,
  });
  assert.deepEqual(v, { kind: 'not_first', firstWeek: '2026-04-05' });
});

test('aliases are normalized: case and whitespace differences do not fake a first paycheck', () => {
  const index = idx([['vet@simple.biz', '2026-05-03']], '2026-03-01');
  const v = classifyFirstPaycheck({ weekStart: '2026-09-13', aliases: ['  Vet@Simple.BIZ '], index, alsoLeaving: false });
  assert.equal(v.kind, 'not_first');
});

// ── Unknown / floor ──────────────────────────────────────────────────────────

test('no alias known to the index → unknown, never labelled', () => {
  const index = idx([['someone@simple.biz', '2026-05-03']], '2026-03-01');
  const v = classifyFirstPaycheck({ weekStart: '2026-09-13', aliases: ['ghost@simple.biz', null, ''], index, alsoLeaving: false });
  assert.deepEqual(v, { kind: 'unknown' });
});

test('the week in view IS the oldest upload on record → history_floor for everyone', () => {
  const index = idx([['a@simple.biz', '2026-03-01'], ['b@simple.biz', '2026-03-01']], '2026-03-01');
  assert.deepEqual(
    classifyFirstPaycheck({ weekStart: '2026-03-01', aliases: ['a@simple.biz'], index, alsoLeaving: false }),
    { kind: 'history_floor' },
  );
});

test('a week OLDER than the recorded floor (stale index) is also a floor, not a false first', () => {
  const index = idx([['a@simple.biz', '2026-03-08']], '2026-03-08');
  assert.deepEqual(
    classifyFirstPaycheck({ weekStart: '2026-03-01', aliases: ['a@simple.biz'], index, alsoLeaving: false }),
    { kind: 'history_floor' },
  );
});

test('an EMPTY index (read failed) has no floor and knows nobody → unknown, never first', () => {
  const index = idx([], null);
  assert.deepEqual(
    classifyFirstPaycheck({ weekStart: '2026-09-13', aliases: ['x@simple.biz'], index, alsoLeaving: false }),
    { kind: 'unknown' },
  );
});

// ── earliestWeekForAliases ───────────────────────────────────────────────────

test('earliestWeekForAliases takes the minimum across every alias', () => {
  const index = idx([['a@x', '2026-06-07'], ['b@x', '2026-04-05'], ['c@x', '2026-08-02']], '2026-03-01');
  assert.equal(earliestWeekForAliases(index, ['a@x', 'b@x', 'c@x']), '2026-04-05');
  assert.equal(earliestWeekForAliases(index, ['nope@x']), undefined);
});

// ── buildFirstHoursIndex ─────────────────────────────────────────────────────

test('buildFirstHoursIndex keeps the minimum week per address regardless of row order', () => {
  const out = buildFirstHoursIndex([
    { email: 'p@simple.biz', weekKey: '2026-09-13' },
    { email: 'P@simple.biz', weekKey: '2026-05-03' },
    { email: 'p@simple.biz', weekKey: '2026-07-05' },
    { email: 'q@simple.biz', weekKey: '2026-09-13' },
  ]);
  assert.equal(out.firstWeekByEmail.get('p@simple.biz'), '2026-05-03');
  assert.equal(out.firstWeekByEmail.get('q@simple.biz'), '2026-09-13');
  assert.equal(out.oldestWeek, '2026-05-03');
  assert.equal(out.skipped, 0);
});

test('buildFirstHoursIndex: an unparseable week is counted as skipped and lowers nobody', () => {
  const out = buildFirstHoursIndex([
    { email: 'p@simple.biz', weekKey: null },
    { email: 'p@simple.biz', weekKey: '2026-09-13' },
    { email: null, weekKey: '2026-09-06' },
  ]);
  assert.equal(out.skipped, 1);
  assert.equal(out.firstWeekByEmail.get('p@simple.biz'), '2026-09-13');
  // A dated row with no email still moves the floor: the upload exists.
  assert.equal(out.oldestWeek, '2026-09-06');
  assert.equal(out.firstWeekByEmail.size, 1);
});

// ── weekKeyFromUploadName ────────────────────────────────────────────────────

test('weekKeyFromUploadName reads the parsed range, junk suffixes included', () => {
  assert.equal(weekKeyFromUploadName('simple-biz_daily_report_2026-08-23_to_2026-08-29 (1).csv'), '2026-08-23');
  assert.equal(weekKeyFromUploadName('simple-biz_daily_report_2026-08-30_to_2026-09-05 4.csv'), '2026-08-30');
  assert.equal(weekKeyFromUploadName('backfill-may10_2026-05-04_to_2026-05-10.csv'), '2026-05-04');
  assert.equal(weekKeyFromUploadName('time-activity-report_2026-04-05_to_2026-05-02.csv'), '2026-04-05');
  assert.equal(weekKeyFromUploadName('random.csv'), null);
  assert.equal(weekKeyFromUploadName(null), null);
});
