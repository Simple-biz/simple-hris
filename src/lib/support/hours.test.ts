import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSupportOpen,
  describeSupportHours,
  describeSupportAvailability,
  hourInViewerZone,
} from './hours';

// Instants are given in UTC so the test itself never depends on where it runs.
const utc = (iso: string) => new Date(iso);

// 2026-09-16 is a Wednesday. US Eastern is on EDT (UTC-4) in September, so
// 13:00Z is 09:00 ET and Manila (UTC+8, no DST) is 21:00.
const WED_0900_ET_SUMMER = utc('2026-09-16T13:00:00Z');
const WED_0859_ET_SUMMER = utc('2026-09-16T12:59:00Z');
const WED_1659_ET_SUMMER = utc('2026-09-16T20:59:00Z');
const WED_1700_ET_SUMMER = utc('2026-09-16T21:00:00Z');

// 2026-01-14 is a Wednesday. Eastern is on EST (UTC-5), so 14:00Z is 09:00 ET
// and Manila is 22:00 — an hour later than in summer.
const WED_0900_ET_WINTER = utc('2026-01-14T14:00:00Z');
const WED_0859_ET_WINTER = utc('2026-01-14T13:59:00Z');

test('open exactly at 9 AM Eastern and shut at 5 PM, in both DST states', () => {
  assert.equal(isSupportOpen(WED_0859_ET_SUMMER), false);
  assert.equal(isSupportOpen(WED_0900_ET_SUMMER), true);
  assert.equal(isSupportOpen(WED_1659_ET_SUMMER), true);
  assert.equal(isSupportOpen(WED_1700_ET_SUMMER), false);

  assert.equal(isSupportOpen(WED_0859_ET_WINTER), false);
  assert.equal(isSupportOpen(WED_0900_ET_WINTER), true);
});

test('the window follows Eastern across a DST change, not a fixed offset', () => {
  // The same wall-clock 9 AM Eastern lands on two DIFFERENT Manila hours either
  // side of the US changeover. A hardcoded -05:00 would make these equal, which
  // is the bug this test exists to catch.
  const summer = hourInViewerZone(9, WED_0900_ET_SUMMER);
  const winter = hourInViewerZone(9, WED_0900_ET_WINTER);
  assert.equal(summer, 21, '9 AM EDT is 9 PM Manila');
  assert.equal(winter, 22, '9 AM EST is 10 PM Manila');
  assert.notEqual(summer, winter);
});

test('closed at the weekend in Eastern terms', () => {
  // Saturday 2026-09-19, 13:00Z = 09:00 ET — inside the hours, wrong day.
  assert.equal(isSupportOpen(utc('2026-09-19T13:00:00Z')), false);
  assert.equal(isSupportOpen(utc('2026-09-20T13:00:00Z')), false);
  // Friday works, Monday works.
  assert.equal(isSupportOpen(utc('2026-09-18T13:00:00Z')), true);
  assert.equal(isSupportOpen(utc('2026-09-21T13:00:00Z')), true);
});

test('a Friday evening in Manila is still Friday working hours in Eastern', () => {
  // Friday 2026-09-18 21:30 Manila = 09:30 ET the same Friday. The employee
  // sees "Friday night" and support is open; keying the weekday off Manila
  // would have called this the weekend.
  assert.equal(isSupportOpen(utc('2026-09-18T13:30:00Z')), true);
});

test('the hours are never printed without naming both zones', () => {
  const summer = describeSupportHours(WED_0900_ET_SUMMER);
  assert.match(summer, /Eastern/);
  assert.match(summer, /Manila/);
  assert.match(summer, /9 AM – 5 PM Eastern/);
  assert.match(summer, /9 PM – 5 AM Manila/);

  // And the Manila half MOVES in winter rather than being a frozen string.
  const winter = describeSupportHours(WED_0900_ET_WINTER);
  assert.match(winter, /10 PM – 6 AM Manila/);
});

test('filing out of hours is invited, not refused', () => {
  const shut = describeSupportAvailability(WED_1700_ET_SUMMER);
  assert.match(shut, /you can still send this/i);
  assert.doesNotMatch(shut, /come back/i);

  assert.match(describeSupportAvailability(WED_0900_ET_SUMMER), /open now/i);
});

test('midnight Eastern does not read as hour 24', () => {
  // Some ICU builds render midnight as '24' under hour12:false; if that leaked
  // through, isSupportOpen would call 00:00 ET "open" because 24 >= 9.
  assert.equal(isSupportOpen(utc('2026-09-16T04:00:00Z')), false); // 00:00 ET
});
