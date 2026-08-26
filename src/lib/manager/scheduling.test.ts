import test from 'node:test';
import assert from 'node:assert/strict';

import { parseShiftWindow } from './shift-window';
import {
  findOverlaps,
  formatRestDays,
  isScheduledDay,
  periodCoversDate,
  scheduledDaysPerWeek,
  scheduledHeadcountByWeekday,
  summarizeScheduling,
  weekdayWeekendLoad,
  type SchedulePeriod,
  type Weekday,
} from './scheduling';

function period(over: Partial<SchedulePeriod> = {}): SchedulePeriod {
  return {
    id: over.id ?? 'p1',
    workEmail: over.workEmail ?? 'someone@simple.biz',
    name: over.name ?? 'Someone',
    department: over.department ?? 'hsl:intake_specialist',
    restDays: over.restDays ?? [0, 6],
    shiftWindow: over.shiftWindow !== undefined ? over.shiftWindow : parseShiftWindow('8AM-4PM'),
    timezone: over.timezone ?? 'America/New_York',
    effectiveFrom: over.effectiveFrom ?? '2026-01-01',
    effectiveTo: over.effectiveTo !== undefined ? over.effectiveTo : null,
  };
}

/**
 * THE test for this module.
 *
 * "No schedule on file" and "scheduled to rest" are different facts, and the second
 * one excuses an absence while the first one does not. This is the same failure
 * class as collapsing "no timesheet record" into "day off" on the coverage panel —
 * so `isScheduledDay` returns null for an uncovered date and the type forces the
 * caller to deal with it.
 *
 * Do not make this pass by returning false. That is the bug.
 */
test('a date outside every period is null, never false', () => {
  const p = period({ effectiveFrom: '2026-03-01', effectiveTo: '2026-03-31' });

  assert.equal(isScheduledDay(p, '2026-02-28'), null, 'before the period: unknown, not "off"');
  assert.equal(isScheduledDay(p, '2026-04-01'), null, 'after the period: unknown, not "off"');

  // Inside the period the answer is a real boolean.
  assert.equal(isScheduledDay(p, '2026-03-03'), true, 'Tue 3 Mar is a working day');
  assert.equal(isScheduledDay(p, '2026-03-07'), false, 'Sat 7 Mar is a rest day');

  // The distinction the whole module exists for.
  assert.notEqual(isScheduledDay(p, '2026-02-28'), isScheduledDay(p, '2026-03-07'));
});

test('effective range is inclusive at both ends', () => {
  const p = period({ effectiveFrom: '2026-03-01', effectiveTo: '2026-03-31' });
  assert.equal(periodCoversDate(p, '2026-03-01'), true);
  assert.equal(periodCoversDate(p, '2026-03-31'), true);
  assert.equal(periodCoversDate(p, '2026-02-28'), false);
  assert.equal(periodCoversDate(p, '2026-04-01'), false);
});

test('an open-ended period covers everything from its start', () => {
  const p = period({ effectiveFrom: '2026-03-01', effectiveTo: null });
  assert.equal(periodCoversDate(p, '2026-03-01'), true);
  assert.equal(periodCoversDate(p, '2030-12-25'), true);
  assert.equal(periodCoversDate(p, '2026-02-28'), false);
});

test('changing a schedule does not rewrite history', () => {
  // The reason periods exist at all: an October change must leave September alone.
  const sept = period({ id: 'a', effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30', restDays: [0, 6] });
  const oct = period({ id: 'b', effectiveFrom: '2026-10-01', effectiveTo: null, restDays: [2, 3] });

  // Sat 5 Sep was a rest day under September's pattern...
  assert.equal(isScheduledDay(sept, '2026-09-05'), false);
  // ...and October's pattern has nothing to say about it.
  assert.equal(isScheduledDay(oct, '2026-09-05'), null);
  // Wed 7 Oct is a rest day only under October's.
  assert.equal(isScheduledDay(oct, '2026-10-07'), false);
  assert.equal(isScheduledDay(sept, '2026-10-07'), null);
});

test('rest days use JS getDay numbering so a stored smallint[] needs no translation', () => {
  const sundayOff = period({ restDays: [0] });
  assert.equal(isScheduledDay(sundayOff, '2026-08-16'), false, '2026-08-16 is a Sunday');
  assert.equal(isScheduledDay(sundayOff, '2026-08-22'), true, '2026-08-22 is a Saturday');
});

test('scheduled days per week is the complement of rest days', () => {
  assert.equal(scheduledDaysPerWeek(period({ restDays: [0, 6] })), 5);
  assert.equal(scheduledDaysPerWeek(period({ restDays: [0] })), 6);
  assert.equal(scheduledDaysPerWeek(period({ restDays: [] })), 7);
  assert.equal(scheduledDaysPerWeek(period({ restDays: [0, 1, 2, 3, 4, 5, 6] })), 0);
});

test('weekday headcount is the forecast a timesheet cannot give', () => {
  const people: SchedulePeriod[] = [
    period({ id: '1', workEmail: 'a@x.co', restDays: [0, 6] }), // Mon–Fri
    period({ id: '2', workEmail: 'b@x.co', restDays: [0, 6] }), // Mon–Fri
    period({ id: '3', workEmail: 'c@x.co', restDays: [2, 3] }), // covers the weekend
  ];
  const by = scheduledHeadcountByWeekday(people);

  assert.equal(by[1], 3, 'Monday: all three');
  assert.equal(by[6], 1, 'Saturday: only the weekend-cover person');
  assert.equal(by[0], 1, 'Sunday: same');
  assert.equal(by[2], 2, 'Tuesday: the two Mon–Fri people');
});

test('weekday headcount respects the effective date when one is given', () => {
  const people: SchedulePeriod[] = [
    period({ id: '1', workEmail: 'a@x.co', effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' }),
    period({ id: '2', workEmail: 'b@x.co', effectiveFrom: '2026-07-01', effectiveTo: null }),
  ];
  assert.equal(scheduledHeadcountByWeekday(people, '2026-03-01')[1], 1);
  assert.equal(scheduledHeadcountByWeekday(people, '2026-08-01')[1], 1);
  assert.equal(scheduledHeadcountByWeekday(people)[1], 2, 'no date = every period counts');
});

test('unscheduled people are counted, not hidden', () => {
  // "We scheduled the team" must never quietly mean "we scheduled 60% of it".
  const s = summarizeScheduling(
    [period({ id: '1', workEmail: 'a@x.co' }), period({ id: '2', workEmail: 'b@x.co' })],
    10,
  );
  assert.equal(s.scheduled, 2);
  assert.equal(s.unscheduled, 8);
});

test('two periods for one person count once toward scheduled headcount', () => {
  const s = summarizeScheduling(
    [
      period({ id: '1', workEmail: 'a@x.co', effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' }),
      period({ id: '2', workEmail: 'A@X.co', effectiveFrom: '2026-07-01' }),
    ],
    5,
  );
  assert.equal(s.scheduled, 1, 'same person, two periods, case-insensitive');
  assert.equal(s.unscheduled, 4);
});

test('a missing shift window is counted, never defaulted to midnight', () => {
  const s = summarizeScheduling(
    [
      period({ id: '1', workEmail: 'a@x.co', shiftWindow: null }),
      period({ id: '2', workEmail: 'b@x.co' }),
    ],
    2,
  );
  assert.equal(s.missingWindow, 1);
});

test('thinnest and fattest weekday surface the weekend gap', () => {
  const s = summarizeScheduling(
    [
      period({ id: '1', workEmail: 'a@x.co', restDays: [0, 6] }),
      period({ id: '2', workEmail: 'b@x.co', restDays: [0, 6] }),
      period({ id: '3', workEmail: 'c@x.co', restDays: [0, 6] }),
    ],
    3,
  );
  assert.equal(s.byWeekday[0], 0, 'nobody covers Sunday');
  assert.equal(s.thinnestDay, 0);
  assert.equal([1, 2, 3, 4, 5].includes(s.fattestDay), true);
});

test('overlapping periods for one person are a hard error, not a warning', () => {
  // An overlap means a date has two answers. The proposed unique index catches
  // exact duplicates but cannot catch a straddle, so it is checked here too.
  const overlapping = [
    period({ id: 'a', workEmail: 'x@x.co', effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' }),
    period({ id: 'b', workEmail: 'x@x.co', effectiveFrom: '2026-05-01', effectiveTo: '2026-12-31' }),
  ];
  assert.equal(findOverlaps(overlapping).length, 1);

  const abutting = [
    period({ id: 'a', workEmail: 'x@x.co', effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' }),
    period({ id: 'b', workEmail: 'x@x.co', effectiveFrom: '2026-07-01', effectiveTo: null }),
  ];
  assert.equal(findOverlaps(abutting).length, 0, 'back-to-back periods do not overlap');

  const openEndedFirst = [
    period({ id: 'a', workEmail: 'x@x.co', effectiveFrom: '2026-01-01', effectiveTo: null }),
    period({ id: 'b', workEmail: 'x@x.co', effectiveFrom: '2026-07-01', effectiveTo: null }),
  ];
  assert.equal(findOverlaps(openEndedFirst).length, 1, 'an open-ended period swallows the next');

  const differentPeople = [
    period({ id: 'a', workEmail: 'x@x.co', effectiveFrom: '2026-01-01', effectiveTo: null }),
    period({ id: 'b', workEmail: 'y@x.co', effectiveFrom: '2026-01-01', effectiveTo: null }),
  ];
  assert.equal(findOverlaps(differentPeople).length, 0);
});

test('rest-day summary never renders as an empty string', () => {
  assert.equal(formatRestDays([]), 'None');
  assert.equal(formatRestDays([0, 6]), 'Sun, Sat');
  assert.equal(formatRestDays([6, 0]), 'Sun, Sat', 'order-independent');
  assert.equal(formatRestDays([0, 1, 2, 3, 4, 5, 6] as Weekday[]), 'Every day');
});

test('weekday/weekend load reports mean AND range, because a mean hides the shape', () => {
  // 12/12/12/12/12 and 20/20/20/0/0 have the same weekday mean. Only the range
  // separates them, and the second is the week a manager has to act on.
  const flat = weekdayWeekendLoad({ 0: 2, 1: 12, 2: 12, 3: 12, 4: 12, 5: 12, 6: 2 });
  const lumpy = weekdayWeekendLoad({ 0: 2, 1: 20, 2: 20, 3: 20, 4: 0, 5: 0, 6: 2 });

  assert.equal(flat.weekdayMean, lumpy.weekdayMean, 'same mean');
  assert.deepEqual([flat.weekdayMin, flat.weekdayMax], [12, 12]);
  assert.deepEqual([lumpy.weekdayMin, lumpy.weekdayMax], [0, 20], 'the range tells them apart');
});

test('weekend is Sat + Sun only; weekday is the other five', () => {
  const l = weekdayWeekendLoad({ 0: 3, 1: 10, 2: 10, 3: 10, 4: 10, 5: 10, 6: 1 });
  assert.equal(l.weekdayMean, 10);
  assert.equal(l.weekendMean, 2, '(3 + 1) / 2');
  assert.deepEqual([l.weekendMin, l.weekendMax], [1, 3]);
});

test('uncovered days are LISTED, not just counted', () => {
  // A zero-cover day is a specific day someone has to go and fix.
  const l = weekdayWeekendLoad({ 0: 0, 1: 5, 2: 5, 3: 5, 4: 5, 5: 5, 6: 0 });
  assert.deepEqual(l.uncoveredDays, [0, 6]);

  const covered = weekdayWeekendLoad({ 0: 1, 1: 5, 2: 5, 3: 5, 4: 5, 5: 5, 6: 1 });
  assert.deepEqual(covered.uncoveredDays, []);
});

test('an all-zero week does not produce NaN or Infinity', () => {
  const l = weekdayWeekendLoad({ 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 });
  assert.equal(l.weekdayMean, 0);
  assert.equal(l.weekendMean, 0);
  assert.equal(l.weekdayMin, 0);
  assert.equal(l.weekdayMax, 0);
  assert.equal(l.uncoveredDays.length, 7);
  for (const v of Object.values(l)) {
    if (typeof v === 'number') assert.ok(Number.isFinite(v), 'every figure stays finite');
  }
});
