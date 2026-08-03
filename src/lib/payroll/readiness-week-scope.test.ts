import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isFutureHireForWeek, startsAfterWeek } from './readiness-week-scope';

// Pay week Sun 2026-07-26 → Sat 2026-08-01.
const WEEK = '2026-07-26';

test('start date after the week end → excluded (future hire)', () => {
  assert.equal(isFutureHireForWeek('2026-08-02', WEEK, false), true);
  assert.equal(isFutureHireForWeek('2026-09-15', WEEK, false), true);
});

test('start date inside or before the week → stays', () => {
  assert.equal(isFutureHireForWeek('2026-08-01', WEEK, false), false); // boundary: week end
  assert.equal(isFutureHireForWeek('2026-07-26', WEEK, false), false); // boundary: week start
  assert.equal(isFutureHireForWeek('2026-01-05', WEEK, false), false);
});

test('hours in the week file always win — onPayroll stays even with a future start date', () => {
  assert.equal(isFutureHireForWeek('2026-08-02', WEEK, true), false);
});

test('missing/unparseable start date fails safe — stays listed', () => {
  assert.equal(isFutureHireForWeek(null, WEEK, false), false);
});

test('startsAfterWeek: after week end → true, else false, null → false', () => {
  assert.equal(startsAfterWeek('2026-08-02', WEEK), true);
  assert.equal(startsAfterWeek('2026-08-01', WEEK), false);
  assert.equal(startsAfterWeek(null, WEEK), false);
});
