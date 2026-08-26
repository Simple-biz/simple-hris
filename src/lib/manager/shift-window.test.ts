import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatShiftWindow,
  parseShiftWindow,
  shiftBucket,
  shiftDurationMinutes,
  shiftWindowKey,
  spansMidnight,
} from './shift-window';

/**
 * THE test for this module. Everything else is supporting detail.
 *
 * A free-text shift column splits one shift into as many categories as there are
 * ways to type it, and every "headcount per shift window" number splits with it.
 * These spellings are all the same 8am–4pm shift and MUST collapse to one key.
 *
 * If someone later makes the parser lenient enough that one of these drifts to a
 * different key, this fails — which is the point. Do not "fix" it by widening the
 * expectation.
 */
test('every spelling of one shift collapses to a single key', () => {
  const spellings = [
    '8AM-4PM',
    '8 AM - 4 PM',
    '8:00 AM - 4:00 PM',
    '8:00 AM – 4:00 PM', // en dash
    '8:00 AM — 4:00 PM', // em dash
    '8:00AM-4:00PM',
    '8 am to 4 pm',
    '8:00 AM TO 4:00 PM EST',
    '8:00 AM until 4:00 PM',
    '08:00-16:00', // 24-hour
    '  8AM   -   4PM  ',
    '8AM\u00a0-\u00a04PM', // non-breaking spaces from a pasted cell
  ];

  const keys = new Set<string>();
  for (const raw of spellings) {
    const w = parseShiftWindow(raw);
    assert.ok(w, `expected "${raw}" to parse`);
    keys.add(shiftWindowKey(w));
  }

  assert.deepEqual([...keys], ['480-960'], `expected one key, got ${[...keys].join(', ')}`);
});

test('the live FPU value parses — it is the only real shift string in the system', () => {
  const w = parseShiftWindow('9 AM TO 5 PM EST');
  assert.deepEqual(w, { startMinute: 540, endMinute: 1020 });
  assert.equal(formatShiftWindow(w!), '9:00 AM – 5:00 PM');
});

test('a one-sided meridiem is REJECTED rather than guessed', () => {
  // "8-4PM" could be 08:00–16:00 or 16:00–16:00. There is no honest pick, so the
  // parser refuses and the value goes back to a human. Do not add an inference
  // branch here to make this pass.
  assert.equal(parseShiftWindow('8-4PM'), null);
  assert.equal(parseShiftWindow('8AM-4'), null);
  assert.equal(parseShiftWindow('9 to 5PM'), null);
});

test('rejects values that are not a readable window', () => {
  for (const bad of [
    null,
    undefined,
    '',
    '   ',
    'mornings',
    '8AM',              // one half only
    '8AM-4PM-6PM',      // three halves
    '13 PM - 4 PM',     // impossible 12-hour reading
    '0 AM - 4 AM',      // hour 0 is not valid on a 12-hour clock
    '8:75 AM - 4:00 PM',// minute out of range
    '25:00-26:00',      // hour out of range
    '24:30-08:00',      // 24:xx is only valid at :00
    '9AM-9AM',          // zero-length window
    '09:00-09:00',
  ]) {
    assert.equal(parseShiftWindow(bad as string), null, `expected "${bad}" to be rejected`);
  }
});

test('midnight and noon land on the right side of the 12-hour clock', () => {
  assert.deepEqual(parseShiftWindow('12 AM - 8 AM'), { startMinute: 0, endMinute: 480 });
  assert.deepEqual(parseShiftWindow('12 PM - 8 PM'), { startMinute: 720, endMinute: 1200 });
  // 24:00 normalizes to 0 so "to midnight" is representable.
  assert.deepEqual(parseShiftWindow('16:00-24:00'), { startMinute: 960, endMinute: 0 });
});

test('overnight windows survive the midnight boundary', () => {
  const w = parseShiftWindow('10:00 PM - 6:00 AM');
  assert.deepEqual(w, { startMinute: 1320, endMinute: 360 });
  assert.equal(spansMidnight(w!), true);
  assert.equal(shiftDurationMinutes(w!), 480, 'an 8-hour overnight shift is 8 hours');
  assert.equal(formatShiftWindow(w!), '10:00 PM – 6:00 AM (+1d)');
});

test('duration is plain subtraction for a same-day window', () => {
  assert.equal(shiftDurationMinutes(parseShiftWindow('8AM-4PM')!), 480);
  assert.equal(shiftDurationMinutes(parseShiftWindow('9:30 AM - 1:00 PM')!), 210);
});

test('display form is stable regardless of how the window was written', () => {
  const a = formatShiftWindow(parseShiftWindow('8AM-4PM')!);
  const b = formatShiftWindow(parseShiftWindow('08:00-16:00')!);
  assert.equal(a, b);
  assert.equal(a, '8:00 AM – 4:00 PM');
});

test('buckets are assigned from the window start', () => {
  assert.equal(shiftBucket(parseShiftWindow('12 AM - 8 AM')!), 'overnight');
  assert.equal(shiftBucket(parseShiftWindow('6AM-2PM')!), 'early');
  assert.equal(shiftBucket(parseShiftWindow('8AM-4PM')!), 'morning');
  assert.equal(shiftBucket(parseShiftWindow('12 PM - 8 PM')!), 'midday');
  assert.equal(shiftBucket(parseShiftWindow('3PM-11PM')!), 'afternoon');
  assert.equal(shiftBucket(parseShiftWindow('7PM-3AM')!), 'evening');
  assert.equal(shiftBucket(parseShiftWindow('11PM-7AM')!), 'night');
});

test('bucketing never changes identity — two windows in one bucket stay distinct', () => {
  const a = parseShiftWindow('8AM-4PM')!;
  const b = parseShiftWindow('9AM-5PM')!;
  assert.equal(shiftBucket(a), shiftBucket(b), 'both are morning shifts');
  assert.notEqual(shiftWindowKey(a), shiftWindowKey(b), 'but they are NOT the same shift');
});
