import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeOffboardDay } from './offboard-date-sanity';

// Fixed clock for every case: 2026-08-07 UTC.
const NOW = new Date('2026-08-07T12:00:00.000Z');

test('a normal past stamp passes through unchanged', () => {
  assert.equal(sanitizeOffboardDay('2026-07-31', NOW), '2026-07-31');
});

test('today passes', () => {
  assert.equal(sanitizeOffboardDay('2026-08-07', NOW), '2026-08-07');
});

test('tomorrow passes (clock-skew / timezone grace)', () => {
  assert.equal(sanitizeOffboardDay('2026-08-08', NOW), '2026-08-08');
});

test('two days ahead is garbage → null', () => {
  assert.equal(sanitizeOffboardDay('2026-08-09', NOW), null);
});

test('the franm@ year-typo (2027-04-20) → null', () => {
  assert.equal(sanitizeOffboardDay('2027-04-20', NOW), null);
});

test('full ISO timestamps are reduced to their day before the check', () => {
  assert.equal(sanitizeOffboardDay('2026-07-31T12:33:58.741+00:00', NOW), '2026-07-31');
  assert.equal(sanitizeOffboardDay('2027-04-20T00:00:00+00:00', NOW), null);
});

test('ancient dates are NOT nulled — they age out through the recency windows', () => {
  assert.equal(sanitizeOffboardDay('2019-01-01', NOW), '2019-01-01');
});

test('null and unparseable input → null', () => {
  assert.equal(sanitizeOffboardDay(null, NOW), null);
  assert.equal(sanitizeOffboardDay('not a date', NOW), null);
  assert.equal(sanitizeOffboardDay('', NOW), null);
});
