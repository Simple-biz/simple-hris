/** Run: node --import tsx --test src/lib/accounting-scoreboard/week.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  datesFor,
  dayHeader,
  isIsoDate,
  isWeekStart,
  todayEastern,
  weekDates,
  weekLabel,
  weekStartOf,
  weekdayOf,
} from './week';

test('isIsoDate accepts real dates only', () => {
  assert.equal(isIsoDate('2026-10-01'), true);
  assert.equal(isIsoDate('2026-02-30'), false);
  assert.equal(isIsoDate('2026-9-1'), false);
  assert.equal(isIsoDate('2026-10-01T00:00:00Z'), false);
  assert.equal(isIsoDate(20261001), false);
});

test('a week is keyed by its Sunday, the HRIS pay-week start', () => {
  assert.equal(weekStartOf('2026-10-01'), '2026-09-27');
  assert.equal(weekStartOf('2026-09-27'), '2026-09-27');
  assert.equal(weekStartOf('2026-10-03'), '2026-09-27', 'Saturday is still the same week');
  assert.equal(weekStartOf('2026-10-04'), '2026-10-04');
  assert.equal(isWeekStart('2026-09-27'), true);
  assert.equal(isWeekStart('2026-09-28'), false);
  // The Dancing Queen weeks bonus_catalog_applied keys: 2026-09-20 … 2026-09-26.
  assert.equal(weekStartOf('2026-09-25'), '2026-09-20');
});

test('weekDates and datesFor return the week in order', () => {
  const w = weekDates('2026-09-27');
  assert.equal(w.sun, '2026-09-27');
  assert.equal(w.mon, '2026-09-28');
  assert.equal(w.fri, '2026-10-02');
  assert.deepEqual(datesFor('2026-09-27', ['mon', 'tue', 'wed', 'thu', 'fri']), [
    '2026-09-28',
    '2026-09-29',
    '2026-09-30',
    '2026-10-01',
    '2026-10-02',
  ]);
  assert.throws(() => weekDates('2026-09-28'), /Sunday/);
});

test('weekdayOf and addDays cross month and year edges', () => {
  assert.equal(weekdayOf('2026-10-01'), 'thu');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2024-03-01', -1), '2024-02-29');
});

test("today is the US Eastern date, whatever the server's zone", () => {
  // 03:30Z on Oct 1 is 11:30 PM on Sep 30 in New York (EDT, UTC−4).
  assert.equal(todayEastern(new Date('2026-10-01T03:30:00Z')), '2026-09-30');
  assert.equal(todayEastern(new Date('2026-10-01T04:30:00Z')), '2026-10-01');
  // January is EST (UTC−5).
  assert.equal(todayEastern(new Date('2026-01-15T04:59:00Z')), '2026-01-14');
});

test('labels read like the sheet', () => {
  assert.equal(weekLabel('2026-09-27'), 'Sep 28 – Oct 2, 2026');
  assert.equal(weekLabel('2026-09-20'), 'Sep 21 – 25, 2026');
  assert.equal(weekLabel('2026-12-27'), 'Dec 28 – Jan 1, 2027');
  assert.deepEqual(dayHeader('2026-09-28'), { weekday: 'Mon', short: '9/28' });
});
