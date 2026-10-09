/**
 * Run: node --import tsx --test src/lib/accounting-scoreboard/payroll-cycle.test.ts
 *
 * Fixtures are the REAL audit events, read 2026-10-01 (Eastern in the comments): the Wizard's own
 * Start Processing stamps (`dispatch.lock_acquired`, carrying the cycle) and the close-outs. Only the
 * times and the date ranges are real; the file names around them are the Hubstaff shape. The first
 * test is Carla's sheet as Kane screenshotted it: This week 9/29 11:01 AM Yes · Last week 9/22 1:21 PM
 * Late, 9/25 3:50 PM Late, 0% · Two weeks ago 9/15 8:09 AM Yes, 9/18 3:50 PM Late, 25% · Average
 * 67% · 0% · 13%. The second replays every earlier week back to the first Wizard start (Kane: "Make
 * sure to check previous weeks").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAYROLL_EVENT_ACTIONS,
  cycleAverages,
  cycleLight,
  cycleRange,
  cycleWeek,
  eventCycleStart,
  handSetCloseFromRecord,
  payrollEventsFrom,
  type CheckState,
  type CycleCloseRecord,
  type HandSetClose,
  type PayrollEvent,
} from './payroll-cycle';
import { formatEasternDateTime } from './week';

const file = (start: string, end: string, suffix = '') => `simple-biz_daily_report_${start}_to_${end}${suffix}.csv`;
/** A Wizard Start Processing stamped with the cycle the Wizard was on. */
const started = (at: string, start: string, end: string): PayrollEvent => ({
  action: 'dispatch.lock_acquired',
  at,
  sourceFile: file(start, end),
  cycleStart: eventCycleStart(start, file(start, end)),
});
const closed = (at: string, f: string): PayrollEvent => ({ action: 'payment_cycle.closed', at, sourceFile: f, cycleStart: eventCycleStart(null, f) });
const reopened = (at: string, f: string): PayrollEvent => ({ action: 'payment_cycle.reopened', at, sourceFile: f, cycleStart: eventCycleStart(null, f) });

/** The first cycle ever closed was Aug 2–8 (closed 8/14). Every cycle that ended before it predates Close Pay Cycle. */
const FIRST_CLOSED = '2026-08-08';
const NOW = '2026-10-01T18:00:00Z'; // Thu 10/1 2:00 PM ET

const EVENTS: PayrollEvent[] = [
  started('2026-06-10T17:16:00Z', '2026-05-31', '2026-06-07'), // Wed 6/10 1:16 PM (an 8-day file)
  started('2026-06-24T17:02:00Z', '2026-06-14', '2026-06-21'), // Wed 6/24 1:02 PM (an 8-day file)
  started('2026-06-24T17:57:00Z', '2026-06-14', '2026-06-21'),
  started('2026-07-04T09:21:00Z', '2026-06-21', '2026-06-27'), // Sat 7/4 5:21 AM
  // Jun 28 – Jul 4 and Jul 5 – 11: payroll ran outside HRIS. No Wizard start, no close.
  started('2026-07-21T12:48:00Z', '2026-07-12', '2026-07-18'), // Tue 7/21 8:48 AM
  started('2026-07-21T17:21:00Z', '2026-07-12', '2026-07-18'),
  // Jul 19–25: Payment Dispatch locked first (Mon 7/27 10:12 PM); that names no cycle and is not here.
  started('2026-07-28T20:07:00Z', '2026-07-19', '2026-07-25'), // Tue 7/28 4:07 PM
  started('2026-08-04T00:32:00Z', '2026-07-26', '2026-08-01'), // Mon 8/3 8:32 PM
  started('2026-08-10T21:47:00Z', '2026-08-02', '2026-08-08'), // Mon 8/10 5:47 PM
  closed('2026-08-14T20:50:00Z', file('2026-08-02', '2026-08-08')), // Fri 8/14 4:50 PM, the first close-out ever
  reopened('2026-08-14T21:13:00Z', file('2026-08-02', '2026-08-08')), // 5:13 PM
  closed('2026-08-14T22:18:00Z', file('2026-08-02', '2026-08-08')), // 6:18 PM, the close that stuck
  started('2026-08-17T14:58:00Z', '2026-08-09', '2026-08-15'), // Mon 8/17 10:58 AM
  closed('2026-08-21T21:56:00Z', file('2026-08-09', '2026-08-15')), // Fri 8/21 5:56 PM
  started('2026-08-24T23:25:00Z', '2026-08-16', '2026-08-22'), // Mon 8/24 7:25 PM
  closed('2026-08-28T19:52:00Z', file('2026-08-16', '2026-08-22')), // Fri 8/28 3:52 PM
  started('2026-09-01T18:49:00Z', '2026-08-23', '2026-08-29'), // Tue 9/1 2:49 PM, never closed (Open item 261)
  started('2026-09-08T17:34:00Z', '2026-08-30', '2026-09-05'), // Tue 9/8 1:34 PM
  closed('2026-09-11T18:33:00Z', file('2026-08-30', '2026-09-05', ' 4')), // Fri 9/11 2:33 PM, the " 4.csv" key
  started('2026-09-15T12:09:00Z', '2026-09-06', '2026-09-12'), // Tue 9/15 8:09 AM
  started('2026-09-15T17:17:00Z', '2026-09-06', '2026-09-12'), // a later re-start the same day
  closed('2026-09-18T19:50:30Z', file('2026-09-06', '2026-09-12')), // Fri 9/18 3:50 PM
  started('2026-09-22T17:21:00Z', '2026-09-13', '2026-09-19'), // Tue 9/22 1:21 PM
  started('2026-09-22T20:41:00Z', '2026-09-13', '2026-09-19'),
  closed('2026-09-25T19:50:10Z', file('2026-09-13', '2026-09-19')), // Fri 9/25 3:50 PM
  started('2026-09-29T15:01:00Z', '2026-09-20', '2026-09-26'), // Tue 9/29 11:01 AM
];

const week = (weekStart: string, events = EVENTS, now = NOW) => cycleWeek(events, weekStart, now, FIRST_CLOSED);
const at = (iso: string | null) => (iso === null ? null : formatEasternDateTime(iso));

test("reproduces Carla's sheet, week by week", () => {
  const thisWeek = week('2026-09-27');
  assert.equal(at(thisWeek.startedAt), '9/29 11:01 AM');
  assert.equal(thisWeek.start, 'on_time');
  assert.equal(thisWeek.closedAt, null);
  assert.equal(thisWeek.close, 'pending', 'Friday noon has not come yet');
  assert.equal(thisWeek.score, null);
  assert.deepEqual(thisWeek.paysWeek, { start: '2026-09-20', end: '2026-09-26' });

  const lastWeek = week('2026-09-20');
  assert.equal(at(lastWeek.startedAt), '9/22 1:21 PM');
  assert.equal(lastWeek.start, 'late');
  assert.equal(at(lastWeek.closedAt), '9/25 3:50 PM');
  assert.equal(lastWeek.close, 'late');
  assert.equal(lastWeek.score, 0);

  const twoAgo = week('2026-09-13');
  assert.equal(at(twoAgo.startedAt), '9/15 8:09 AM', 'the FIRST Wizard start of the cycle, not the later re-start');
  assert.equal(twoAgo.start, 'on_time');
  assert.equal(at(twoAgo.closedAt), '9/18 3:50 PM');
  assert.equal(twoAgo.close, 'late');
  assert.equal(twoAgo.score, 25);

  const avg = cycleAverages([thisWeek, lastWeek, twoAgo]);
  assert.equal(Math.round(avg.startOnTime!), 67);
  assert.equal(avg.closeOnTime, 0);
  assert.equal(Math.round(avg.score!), 13);
});

test('every previous week, replayed from the real Wizard and close-out events', () => {
  // [processing week, started (ET), start, closed (ET), close, score]
  const expected: [string, string | null, CheckState, string | null, CheckState, number | null][] = [
    ['2026-06-07', '6/10 1:16 PM', 'late', null, 'no_record', null], // before Close Pay Cycle existed
    ['2026-06-14', null, 'no_record', null, 'no_record', null], // Jun 7–13: outside HRIS
    ['2026-06-21', '6/24 1:02 PM', 'late', null, 'no_record', null],
    ['2026-06-28', '7/4 5:21 AM', 'late', null, 'no_record', null],
    ['2026-07-05', null, 'no_record', null, 'no_record', null], // outside HRIS
    ['2026-07-12', null, 'no_record', null, 'no_record', null], // outside HRIS
    ['2026-07-19', '7/21 8:48 AM', 'on_time', null, 'no_record', null],
    ['2026-07-26', '7/28 4:07 PM', 'late', null, 'no_record', null], // NOT Dispatch's 7/27 10:12 PM
    ['2026-08-02', '8/3 8:32 PM', 'on_time', null, 'no_record', null], // Jul 26 – Aug 1 ended before the first close-out
    ['2026-08-09', '8/10 5:47 PM', 'on_time', '8/14 6:18 PM', 'late', 25], // closed, reopened, closed again
    ['2026-08-16', '8/17 10:58 AM', 'on_time', '8/21 5:56 PM', 'late', 25],
    ['2026-08-23', '8/24 7:25 PM', 'on_time', '8/28 3:52 PM', 'late', 25],
    ['2026-08-30', '9/1 2:49 PM', 'late', null, 'missed', 0], // Aug 23–29 was never closed
    ['2026-09-06', '9/8 1:34 PM', 'late', '9/11 2:33 PM', 'late', 0], // matched through the " 4.csv" name
    ['2026-09-13', '9/15 8:09 AM', 'on_time', '9/18 3:50 PM', 'late', 25],
    ['2026-09-20', '9/22 1:21 PM', 'late', '9/25 3:50 PM', 'late', 0],
    ['2026-09-27', '9/29 11:01 AM', 'on_time', null, 'pending', null],
  ];
  for (const [weekStart, startAt, start, closeAt, close, score] of expected) {
    const w = week(weekStart);
    assert.deepEqual(
      { startAt: at(w.startedAt), start: w.start, closeAt: at(w.closedAt), close: w.close, score: w.score },
      { startAt, start, closeAt, close, score },
      `processing week ${weekStart}`,
    );
  }
});

test("Payment Dispatch's lock is not an input: only the Wizard's stamped start names a cycle", () => {
  assert.deepEqual([...PAYROLL_EVENT_ACTIONS], ['dispatch.lock_acquired', 'payment_cycle.closed', 'payment_cycle.reopened']);
  assert.ok(!(PAYROLL_EVENT_ACTIONS as readonly string[]).includes('payroll.dispatch.locked'));
});

test('a start belongs to its own cycle, whenever it happened', () => {
  // The Sep 13–19 cycle started (late) during the NEXT processing week.
  const late = [started('2026-09-29T14:00:00Z', '2026-09-13', '2026-09-19')];
  assert.equal(week('2026-09-20', late).start, 'late');
  assert.equal(at(week('2026-09-20', late).startedAt), '9/29 10:00 AM');
  assert.equal(week('2026-09-27', late).startedAt, null, 'it is not the Sep 20–26 cycle starting');
});

test('the deadlines are noon Eastern, on the dot counts as on time', () => {
  const s = (iso: string) => [started(iso, '2026-09-20', '2026-09-26')];
  assert.equal(week('2026-09-27', s('2026-09-29T16:00:00Z')).start, 'on_time'); // Tue 12:00 PM EDT
  assert.equal(week('2026-09-27', s('2026-09-29T16:01:00Z')).start, 'late');
  // Winter: EST is UTC−5, so Tuesday noon is 17:00Z.
  const winter = (iso: string) => cycleWeek([started(iso, '2026-01-04', '2026-01-10')], '2026-01-11', '2026-01-20T00:00:00Z', FIRST_CLOSED);
  assert.equal(winter('2026-01-13T17:00:00Z').start, 'on_time');
  assert.equal(winter('2026-01-13T17:01:00Z').start, 'late');
});

test('no start yet: pending before the deadline, missed while the week runs, no record once it is over', () => {
  assert.equal(week('2026-09-27', [], '2026-09-29T15:00:00Z').start, 'pending'); // Tue 11 AM
  const tuesday1pm = week('2026-09-27', [], '2026-09-29T17:00:00Z');
  assert.equal(tuesday1pm.start, 'missed');
  assert.equal(tuesday1pm.score, null, 'the close is still pending');
  assert.equal(week('2026-09-27', [], '2026-10-03T23:00:00Z').start, 'missed', 'Saturday 7 PM ET is still the week');
  const over = week('2026-09-27', [], '2026-10-04T05:00:00Z'); // Sun 1 AM ET
  assert.equal(over.start, 'no_record', 'the Wizard never started it: payroll ran outside HRIS');
  assert.equal(over.close, 'missed', 'Close Pay Cycle existed, so a close that never came is a miss');
  assert.equal(over.score, null, 'nothing to score without a judged start');
});

test('a cycle that ended before the first close-out was filed has no close to judge', () => {
  const w = week('2026-08-02');
  assert.equal(w.paysWeek.end, '2026-08-01');
  assert.equal(w.close, 'no_record');
  assert.equal(cycleLight(w), 'green', 'judged on its start alone');
  const firstClosed = week('2026-08-09');
  assert.equal(firstClosed.close, 'late', 'the boundary cycle itself was closed');
  // With no close-out ever filed, nothing is exempt (Diagnostics' rule).
  assert.equal(cycleWeek([], '2026-08-02', NOW, null).close, 'missed');
});

test('a close is matched on the PARSED date range, so a drifted name still counts', () => {
  const w = week('2026-09-20', [closed('2026-09-25T15:00:00Z', file('2026-09-13', '2026-09-19', ' (1)'))]);
  assert.equal(w.close, 'on_time');
  const other = week('2026-09-20', [closed('2026-09-25T15:00:00Z', file('2026-09-06', '2026-09-12'))]);
  assert.equal(other.closedAt, null, "another cycle's close is not this week's");
  assert.equal(cycleRange('no dates here.csv'), null);
});

test('a reopen after the close opens the cycle again; a later close counts', () => {
  const f = file('2026-09-13', '2026-09-19');
  const open = week('2026-09-20', [closed('2026-09-25T15:00:00Z', f), reopened('2026-09-25T17:00:00Z', f)]);
  assert.equal(open.closedAt, null);
  assert.equal(open.reopened, true);
  assert.equal(open.close, 'missed');
  const reclosed = week('2026-09-20', [closed('2026-09-25T15:00:00Z', f), reopened('2026-09-25T17:00:00Z', f), closed('2026-09-25T18:00:00Z', f)]);
  assert.equal(reclosed.reopened, false);
  assert.equal(reclosed.close, 'late', 'judged on the close that stuck (2 PM, after the noon deadline)');
});

test('eventCycleStart: the Wizard period first, the file name as fallback, the Sunday it starts on', () => {
  assert.equal(eventCycleStart('2026-09-20', 'anything.csv'), '2026-09-20');
  assert.equal(eventCycleStart(null, file('2026-09-20', '2026-09-26')), '2026-09-20');
  assert.equal(eventCycleStart(undefined, file('2026-09-20', '2026-09-26', ' (1)')), '2026-09-20');
  assert.equal(eventCycleStart('2026-09-22', null), '2026-09-20', 'a mid-week period start maps to its Sunday');
  assert.equal(eventCycleStart('not a date', 'no dates.csv'), null);
  assert.equal(eventCycleStart(null, null), null);
  const unreadable: PayrollEvent = { action: 'dispatch.lock_acquired', at: '2026-09-29T13:00:00Z', sourceFile: null, cycleStart: null };
  assert.equal(week('2026-09-27', [unreadable]).startedAt, null, 'an event naming no readable cycle never counts');
});

test('scores: start on time 25 + close on time 75', () => {
  const f = file('2026-09-13', '2026-09-19');
  const both = week('2026-09-20', [started('2026-09-22T13:00:00Z', '2026-09-13', '2026-09-19'), closed('2026-09-25T14:00:00Z', f)]);
  assert.equal(both.score, 100);
  const closeOnly = week('2026-09-20', [started('2026-09-22T19:00:00Z', '2026-09-13', '2026-09-19'), closed('2026-09-25T14:00:00Z', f)]);
  assert.equal(closeOnly.score, 75);
});

test('averages and lights leave no_record out', () => {
  const weeks = [week('2026-07-12'), week('2026-07-19'), week('2026-07-26')];
  const avg = cycleAverages(weeks);
  assert.equal(avg.startOnTime, 50, 'one on time of the two judged starts; the outside-HRIS week is not a vote');
  assert.equal(avg.closeOnTime, null, 'no close was judged');
  assert.equal(avg.score, null);
  assert.equal(cycleLight(week('2026-07-12')), 'none');
});

test('cycle stop light: all decided on time green, none red, a mix amber, nothing decided none', () => {
  assert.equal(cycleLight({ start: 'on_time', close: 'pending' }), 'green');
  assert.equal(cycleLight({ start: 'on_time', close: 'on_time' }), 'green');
  assert.equal(cycleLight({ start: 'on_time', close: 'late' }), 'amber');
  assert.equal(cycleLight({ start: 'late', close: 'late' }), 'red');
  assert.equal(cycleLight({ start: 'missed', close: 'pending' }), 'red');
  assert.equal(cycleLight({ start: 'pending', close: 'pending' }), 'none');
  assert.equal(cycleLight({ start: 'no_record', close: 'no_record' }), 'none');
  assert.equal(cycleLight({ start: 'late', close: 'no_record' }), 'red');
});

// ---------------------------------------------------------------------------
// A close set by hand (Open item 437). The audit events are the REAL ones for the Sep 27 – Oct 3 cycle,
// read 2026-10-09: Wizard start Tue 10/6 11:59 AM, Close Pay Cycle Fri 10/9 12:00:32 PM, reopened 12:01:03 PM.
// Kane: "I just want todays cycle to be closed at 11:55", then "override".
// ---------------------------------------------------------------------------

const OCT3 = file('2026-09-27', '2026-10-03');
const OCT9_EVENTS: PayrollEvent[] = [
  started('2026-10-06T15:59:09Z', '2026-09-27', '2026-10-03'),
  closed('2026-10-09T16:00:32Z', OCT3),
  reopened('2026-10-09T16:01:03Z', OCT3),
];
const OCT9_NOW = '2026-10-09T16:30:00Z'; // Fri 10/9 12:30 PM ET
const handRecord = (over: Partial<CycleCloseRecord> = {}): CycleCloseRecord => ({
  cycle_start: '2026-09-27',
  closed_at: '2026-10-09T15:55:00+00:00',
  set_by: 'kaner@simple.biz',
  reason: 'Kane, 2026-10-09 (Open item 437).',
  set_at: '2026-10-09T16:20:00+00:00',
  ...over,
});
const hand = (over: Partial<CycleCloseRecord> = {}): HandSetClose => {
  const e = handSetCloseFromRecord(handRecord(over));
  assert.ok(e !== null);
  return e;
};
const oct = (events: PayrollEvent[], now = OCT9_NOW) => cycleWeek(events, '2026-10-04', now, FIRST_CLOSED);

test('the record alone: the 10/9 close was reopened, so past Friday noon the close is missed', () => {
  const w = oct(OCT9_EVENTS);
  assert.equal(w.start, 'on_time');
  assert.equal(w.closedAt, null);
  assert.equal(w.reopened, true);
  assert.equal(w.close, 'missed');
  assert.equal(w.closeSetByHand, null);
  assert.equal(w.score, 25);
});

test('a close set by hand replaces the record (and its reopen), and says it was set by hand', () => {
  const w = oct([...OCT9_EVENTS, hand()]);
  assert.equal(at(w.closedAt), '10/9 11:55 AM');
  assert.equal(w.close, 'on_time');
  assert.equal(w.reopened, false);
  assert.deepEqual(w.closeSetByHand, { setBy: 'kaner@simple.biz', reason: 'Kane, 2026-10-09 (Open item 437).', setAt: '2026-10-09T16:20:00.000Z' });
  assert.equal(w.score, 100);
  assert.equal(cycleLight(w), 'green');
});

test('a hand-set close outlasts a later Close Pay Cycle of the same cycle', () => {
  const w = oct([...OCT9_EVENTS, hand(), closed('2026-10-09T17:10:00Z', OCT3)], '2026-10-09T18:00:00Z');
  assert.equal(at(w.closedAt), '10/9 11:55 AM');
  assert.ok(w.closeSetByHand !== null);
});

test('the newest hand-set close wins; a cleared one hands the cycle back to the record', () => {
  const later = hand({ closed_at: '2026-10-09T16:05:00Z', set_at: '2026-10-09T16:25:00Z' });
  assert.equal(at(oct([...OCT9_EVENTS, later, hand()]).closedAt), '10/9 12:05 PM', 'order in the list does not matter');
  const cleared = hand({ closed_at: null, set_at: '2026-10-09T16:25:00Z' });
  const w = oct([...OCT9_EVENTS, hand(), cleared]);
  assert.equal(w.closedAt, null);
  assert.equal(w.close, 'missed');
  assert.equal(w.closeSetByHand, null);
});

test("a hand-set close touches only its own cycle, and never the start", () => {
  const other = oct([...OCT9_EVENTS, hand({ cycle_start: '2026-09-20', closed_at: '2026-10-02T15:00:00Z' })]);
  assert.equal(other.close, 'missed');
  assert.equal(other.closeSetByHand, null);
  const w = oct([...OCT9_EVENTS, hand()]);
  assert.equal(at(w.startedAt), '10/6 11:59 AM');
  assert.equal(week('2026-10-04', [...EVENTS, hand()], OCT9_NOW).startedAt, null, 'it adds no start');
});

test('an unreadable hand-set row never counts; payrollEventsFrom merges both sources', () => {
  assert.equal(handSetCloseFromRecord(handRecord({ cycle_start: '2026-09-28' })), null, 'not a Sunday');
  assert.equal(handSetCloseFromRecord(handRecord({ cycle_start: 'soon' })), null);
  assert.equal(handSetCloseFromRecord(handRecord({ set_at: 'never' })), null);
  assert.equal(handSetCloseFromRecord(handRecord({ closed_at: 'never' })), null);
  const events = payrollEventsFrom(
    [{ action: 'payment_cycle.closed', created_at: '2026-10-09T16:00:32Z', resource_id: OCT3, src: OCT3, csrc: null, cps: null }],
    [handRecord(), handRecord({ cycle_start: '2026-09-28' })],
  );
  assert.deepEqual(events.map((e) => e.action), ['payment_cycle.closed', 'close_set_by_hand']);
  assert.ok(!(PAYROLL_EVENT_ACTIONS as readonly string[]).includes('close_set_by_hand'), 'never read from audit_log');
});
