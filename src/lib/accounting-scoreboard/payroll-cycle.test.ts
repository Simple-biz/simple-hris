/**
 * Run: node --import tsx --test src/lib/accounting-scoreboard/payroll-cycle.test.ts
 *
 * Fixtures are the REAL audit events (read 2026-10-01, Eastern in the comments). The assertions are
 * Carla's sheet as Kane screenshotted it: This week 9/29 11:01 AM Yes · Last week 9/22 1:21 PM Late,
 * 9/25 3:50 PM Late, 0% · Two weeks ago 9/15 8:09 AM Yes, 9/18 3:50 PM Late, 25% · Average 67% · 0% · 13%.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cycleAverages, cycleLight, cycleRange, cycleWeek, type PayrollEvent } from './payroll-cycle';
import { formatEasternDateTime } from './week';

const lock = (at: string): PayrollEvent => ({ action: 'payroll.dispatch.locked', at, sourceFile: null });
const closed = (at: string, file: string): PayrollEvent => ({ action: 'payment_cycle.closed', at, sourceFile: file });

const EVENTS: PayrollEvent[] = [
  lock('2026-09-15T12:09:00Z'), // Tue 9/15 8:09 AM ET
  lock('2026-09-15T17:17:00Z'),
  lock('2026-09-15T18:00:00Z'),
  lock('2026-09-18T19:50:00Z'),
  closed('2026-09-18T19:50:30Z', 'simple-biz_daily_report_2026-09-06_to_2026-09-12.csv'), // Fri 9/18 3:50 PM
  lock('2026-09-22T17:21:00Z'), // Tue 9/22 1:21 PM
  lock('2026-09-22T20:41:00Z'),
  lock('2026-09-25T15:20:00Z'),
  closed('2026-09-25T19:50:10Z', 'simple-biz_daily_report_2026-09-13_to_2026-09-19.csv'), // Fri 9/25 3:50 PM
  lock('2026-09-29T15:01:00Z'), // Tue 9/29 11:01 AM
];
const NOW = '2026-10-01T18:00:00Z'; // Thu 10/1 2:00 PM ET

test("reproduces Carla's sheet, week by week", () => {
  const thisWeek = cycleWeek(EVENTS, '2026-09-27', NOW);
  assert.equal(formatEasternDateTime(thisWeek.startedAt!), '9/29 11:01 AM');
  assert.equal(thisWeek.start, 'on_time');
  assert.equal(thisWeek.closedAt, null);
  assert.equal(thisWeek.close, 'pending', 'Friday noon has not come yet');
  assert.equal(thisWeek.score, null);
  assert.deepEqual(thisWeek.paysWeek, { start: '2026-09-20', end: '2026-09-26' });

  const lastWeek = cycleWeek(EVENTS, '2026-09-20', NOW);
  assert.equal(formatEasternDateTime(lastWeek.startedAt!), '9/22 1:21 PM');
  assert.equal(lastWeek.start, 'late');
  assert.equal(formatEasternDateTime(lastWeek.closedAt!), '9/25 3:50 PM');
  assert.equal(lastWeek.close, 'late');
  assert.equal(lastWeek.score, 0);

  const twoAgo = cycleWeek(EVENTS, '2026-09-13', NOW);
  assert.equal(formatEasternDateTime(twoAgo.startedAt!), '9/15 8:09 AM', 'the FIRST lock of the week, not a later re-lock');
  assert.equal(twoAgo.start, 'on_time');
  assert.equal(formatEasternDateTime(twoAgo.closedAt!), '9/18 3:50 PM');
  assert.equal(twoAgo.close, 'late');
  assert.equal(twoAgo.score, 25);

  const avg = cycleAverages([thisWeek, lastWeek, twoAgo]);
  assert.equal(Math.round(avg.startOnTime!), 67);
  assert.equal(avg.closeOnTime, 0);
  assert.equal(Math.round(avg.score!), 13);
});

test('the deadlines are noon Eastern, on the dot counts as on time', () => {
  const onTheDot = cycleWeek([lock('2026-09-29T16:00:00Z')], '2026-09-27', NOW); // Tue 12:00 PM EDT
  assert.equal(onTheDot.start, 'on_time');
  const aMinuteLate = cycleWeek([lock('2026-09-29T16:01:00Z')], '2026-09-27', NOW);
  assert.equal(aMinuteLate.start, 'late');
  // Winter: EST is UTC−5, so Tuesday noon is 17:00Z.
  assert.equal(cycleWeek([lock('2026-01-13T17:00:00Z')], '2026-01-11', '2026-01-20T00:00:00Z').start, 'on_time');
  assert.equal(cycleWeek([lock('2026-01-13T17:01:00Z')], '2026-01-11', '2026-01-20T00:00:00Z').start, 'late');
});

test('nothing yet: pending before the deadline, missed after it', () => {
  const before = cycleWeek([], '2026-09-27', '2026-09-29T15:00:00Z'); // Tue 11 AM
  assert.equal(before.start, 'pending');
  const after = cycleWeek([], '2026-09-27', '2026-09-29T17:00:00Z'); // Tue 1 PM
  assert.equal(after.start, 'missed');
  assert.equal(after.score, null, 'the close is still pending');
  const weekOver = cycleWeek([], '2026-09-20', NOW);
  assert.equal(weekOver.score, 0, 'missed both = 0%');
});

test('a close is matched on the PARSED date range, so a " (1).csv" name still counts', () => {
  const w = cycleWeek([closed('2026-09-25T15:00:00Z', 'simple-biz_daily_report_2026-09-13_to_2026-09-19 (1).csv')], '2026-09-20', NOW);
  assert.equal(w.close, 'on_time');
  const other = cycleWeek([closed('2026-09-25T15:00:00Z', 'simple-biz_daily_report_2026-09-06_to_2026-09-12.csv')], '2026-09-20', NOW);
  assert.equal(other.closedAt, null, "another cycle's close is not this week's");
  assert.equal(cycleRange('no dates here.csv'), null);
});

test('a reopen after the close opens the cycle again; a later close counts', () => {
  const file = 'simple-biz_daily_report_2026-09-13_to_2026-09-19.csv';
  const reopen: PayrollEvent = { action: 'payment_cycle.reopened', at: '2026-09-25T17:00:00Z', sourceFile: file };
  const open = cycleWeek([closed('2026-09-25T15:00:00Z', file), reopen], '2026-09-20', NOW);
  assert.equal(open.closedAt, null);
  assert.equal(open.reopened, true);
  assert.equal(open.close, 'missed');
  const reclosed = cycleWeek([closed('2026-09-25T15:00:00Z', file), reopen, closed('2026-09-25T18:00:00Z', file)], '2026-09-20', NOW);
  assert.equal(reclosed.reopened, false);
  assert.equal(reclosed.close, 'late', 'judged on the close that stuck (2 PM, after the noon deadline)');
});

test('a lock from another week never counts as this week starting', () => {
  const w = cycleWeek([lock('2026-09-25T15:20:00Z')], '2026-09-27', NOW);
  assert.equal(w.startedAt, null);
});

test('scores: start on time 25 + close on time 75', () => {
  const file = 'simple-biz_daily_report_2026-09-13_to_2026-09-19.csv';
  const both = cycleWeek([lock('2026-09-22T13:00:00Z'), closed('2026-09-25T14:00:00Z', file)], '2026-09-20', NOW);
  assert.equal(both.score, 100);
  const closeOnly = cycleWeek([lock('2026-09-22T19:00:00Z'), closed('2026-09-25T14:00:00Z', file)], '2026-09-20', NOW);
  assert.equal(closeOnly.score, 75);
});

test('cycle stop light: all decided on time green, none red, a mix amber, nothing decided none', () => {
  assert.equal(cycleLight({ start: 'on_time', close: 'pending' }), 'green');
  assert.equal(cycleLight({ start: 'on_time', close: 'on_time' }), 'green');
  assert.equal(cycleLight({ start: 'on_time', close: 'late' }), 'amber');
  assert.equal(cycleLight({ start: 'late', close: 'late' }), 'red');
  assert.equal(cycleLight({ start: 'missed', close: 'pending' }), 'red');
  assert.equal(cycleLight({ start: 'pending', close: 'pending' }), 'none');
});
