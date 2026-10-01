import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatNotificationTimestamp, notificationCardTimestamp } from './notification-timestamp';

// Kane's own example, 2026-10-01. April 5, 1999 was the day after Eastern
// daylight time began, so 8:00 AM on the wall clock is 12:00Z.
test("Kane's example renders exactly", () => {
  assert.equal(formatNotificationTimestamp('1999-04-05T12:00:00Z'), 'April 5, 1999 : 8:00 AM EST');
});

test('winter: 13:00Z is 8:00 AM Eastern', () => {
  assert.equal(formatNotificationTimestamp('2026-01-15T13:00:00Z'), 'January 15, 2026 : 8:00 AM EST');
});

// The clock is the IANA zone, never a fixed -05:00: in July 12:00Z is 8 AM on
// the Eastern wall clock. A fixed offset would print 7:00 AM.
test('summer follows Eastern daylight time, label stays EST', () => {
  assert.equal(formatNotificationTimestamp('2026-07-04T12:00:00Z'), 'July 4, 2026 : 8:00 AM EST');
});

// The DATE is Eastern too — 03:30Z on Oct 2 is still Oct 1 in New York (and
// already Oct 2 in Manila, where most readers sit).
test('the date is the Eastern date, not UTC or Manila', () => {
  assert.equal(formatNotificationTimestamp('2026-10-02T03:30:00Z'), 'October 1, 2026 : 11:30 PM EST');
});

test('midnight and noon read 12, never 0', () => {
  assert.equal(formatNotificationTimestamp('2026-01-15T05:00:00Z'), 'January 15, 2026 : 12:00 AM EST');
  assert.equal(formatNotificationTimestamp('2026-01-15T17:05:00Z'), 'January 15, 2026 : 12:05 PM EST');
});

test('a plain ASCII space before AM/PM (no U+202F)', () => {
  const s = formatNotificationTimestamp('2026-01-15T13:00:00Z')!;
  assert.ok(!s.includes(' ') && !s.includes(' '), JSON.stringify(s));
});

test('missing or malformed input is null, never "Invalid Date"', () => {
  assert.equal(formatNotificationTimestamp(null), null);
  assert.equal(formatNotificationTimestamp(undefined), null);
  assert.equal(formatNotificationTimestamp(''), null);
  assert.equal(formatNotificationTimestamp('not a date'), null);
});

test('a card prefers a real submitted_at and falls back to created_at', () => {
  const created = '2026-01-15T13:00:00Z';
  assert.equal(notificationCardTimestamp('2026-01-14T14:00:00Z', created), 'January 14, 2026 : 9:00 AM EST');
  assert.equal(notificationCardTimestamp(null, created), 'January 15, 2026 : 8:00 AM EST');
  assert.equal(notificationCardTimestamp('garbage', created), 'January 15, 2026 : 8:00 AM EST');
});
