import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeAdjustmentDeltas, isInPayWeek } from './time-adjustment-week-scope';

const WEEK = { startKey: '2026-09-13', endKey: '2026-09-19' };

function byEmail(entries: Record<string, Record<string, number>>): Map<string, Map<string, number>> {
  return new Map(Object.entries(entries).map(([em, days]) => [em, new Map(Object.entries(days))]));
}

// The defect, measured on production 2026-09-22. juliar@'s 2026-09-10
// adjustment was paid on the 09-06→09-12 week (₱23.33, dispatched 09-15) and
// then folded into the live 09-13→09-19 week a SECOND time, because the scope
// was the PAB MONTH and 09-10 is inside September.
test('never credits a date from an earlier week that was already paid', () => {
  const out = buildTimeAdjustmentDeltas({
    approvedByEmail: byEmail({ 'juliar@simple.biz': { '2026-09-10': 8.6767 } }),
    rawByEmail: byEmail({ 'juliar@simple.biz': { '2026-09-10': 8.5933 } }),
    payWeek: WEEK,
  });
  assert.equal(out.has('juliar@simple.biz'), false);
});

test("credits an in-week date at the delta against that day's own tracked hours", () => {
  const out = buildTimeAdjustmentDeltas({
    approvedByEmail: byEmail({ 'a@x.com': { '2026-09-16': 9 } }),
    rawByEmail: byEmail({ 'a@x.com': { '2026-09-16': 8 } }),
    payWeek: WEEK,
  });
  assert.deepEqual(out.get('a@x.com'), { hours: 1, days: [{ date: '2026-09-16', hours: 1 }] });
});

test('the week bounds are inclusive on both ends', () => {
  const out = buildTimeAdjustmentDeltas({
    approvedByEmail: byEmail({ 'a@x.com': { '2026-09-13': 1, '2026-09-19': 2 } }),
    rawByEmail: byEmail({}),
    payWeek: WEEK,
  });
  assert.deepEqual(
    out.get('a@x.com')?.days.map((d) => d.date),
    ['2026-09-13', '2026-09-19'],
  );
});

test('excludes the day before and the day after the week', () => {
  const out = buildTimeAdjustmentDeltas({
    approvedByEmail: byEmail({ 'a@x.com': { '2026-09-12': 5, '2026-09-20': 5 } }),
    rawByEmail: byEmail({}),
    payWeek: WEEK,
  });
  assert.equal(out.has('a@x.com'), false);
});

test('keeps only the in-week days when one person has days on both sides', () => {
  const out = buildTimeAdjustmentDeltas({
    approvedByEmail: byEmail({ 'a@x.com': { '2026-09-10': 8, '2026-09-16': 9 } }),
    rawByEmail: byEmail({ 'a@x.com': { '2026-09-10': 7, '2026-09-16': 8 } }),
    payWeek: WEEK,
  });
  assert.deepEqual(out.get('a@x.com'), { hours: 1, days: [{ date: '2026-09-16', hours: 1 }] });
});

// Rule 3. The old `periodDates.size > 0 &&` guard disabled ITSELF when no date
// column parsed, so "I cannot tell which week this is" paid every approved
// adjustment on record.
test('credits NOTHING when the pay week cannot be resolved — it never falls open', () => {
  const out = buildTimeAdjustmentDeltas({
    approvedByEmail: byEmail({ 'a@x.com': { '2026-09-16': 9 }, 'b@x.com': { '2026-05-08': 7 } }),
    rawByEmail: byEmail({ 'a@x.com': { '2026-09-16': 8 } }),
    payWeek: null,
  });
  assert.equal(out.size, 0);
});

// A pre-2026-09-15 row carries a stored `approved_hours` that wins outright and
// is SET-semantics, so an out-of-week leak re-pays a WHOLE DAY, not minutes.
// adriant@ 2026-05-08 stores 7.0h — ₱1,960 a week at a ₱280 rate.
test('does not leak a stored-total day into an unrelated week', () => {
  const out = buildTimeAdjustmentDeltas({
    approvedByEmail: byEmail({ 'adriant@simple.biz': { '2026-05-08': 7 } }),
    rawByEmail: byEmail({}),
    payWeek: WEEK,
  });
  assert.equal(out.size, 0);
});

test('keeps an entry for a 0h net delta so the export can still name the date', () => {
  const out = buildTimeAdjustmentDeltas({
    approvedByEmail: byEmail({ 'a@x.com': { '2026-09-16': 8 } }),
    rawByEmail: byEmail({ 'a@x.com': { '2026-09-16': 8 } }),
    payWeek: WEEK,
  });
  assert.deepEqual(out.get('a@x.com'), { hours: 0, days: [{ date: '2026-09-16', hours: 0 }] });
});

test('treats a day with no tracked entry as 0 tracked', () => {
  const out = buildTimeAdjustmentDeltas({
    approvedByEmail: byEmail({ 'a@x.com': { '2026-09-16': 3.5 } }),
    rawByEmail: byEmail({}),
    payWeek: WEEK,
  });
  assert.equal(out.get('a@x.com')?.hours, 3.5);
});

test('carries a negative delta through — a correction may lower a day', () => {
  const out = buildTimeAdjustmentDeltas({
    approvedByEmail: byEmail({ 'a@x.com': { '2026-09-16': 6 } }),
    rawByEmail: byEmail({ 'a@x.com': { '2026-09-16': 8 } }),
    payWeek: WEEK,
  });
  assert.deepEqual(out.get('a@x.com'), { hours: -2, days: [{ date: '2026-09-16', hours: -2 }] });
});

test('rounds the per-day disclosure to 2dp but sums the unrounded delta', () => {
  const out = buildTimeAdjustmentDeltas({
    approvedByEmail: byEmail({ 'a@x.com': { '2026-09-16': 8.083333333, '2026-09-17': 8.083333333 } }),
    rawByEmail: byEmail({ 'a@x.com': { '2026-09-16': 8, '2026-09-17': 8 } }),
    payWeek: WEEK,
  });
  assert.deepEqual(out.get('a@x.com')?.days, [
    { date: '2026-09-16', hours: 0.08 },
    { date: '2026-09-17', hours: 0.08 },
  ]);
  assert.ok(Math.abs((out.get('a@x.com')?.hours ?? 0) - 0.166666666) < 1e-6);
});

test('returns an empty map when nobody has an approved adjustment', () => {
  const out = buildTimeAdjustmentDeltas({ approvedByEmail: new Map(), rawByEmail: new Map(), payWeek: WEEK });
  assert.equal(out.size, 0);
});

test('isInPayWeek is false for every date when the week is unknown', () => {
  assert.equal(isInPayWeek('2026-09-16', null), false);
});

test('isInPayWeek is inclusive on both bounds', () => {
  assert.equal(isInPayWeek('2026-09-13', WEEK), true);
  assert.equal(isInPayWeek('2026-09-19', WEEK), true);
  assert.equal(isInPayWeek('2026-09-12', WEEK), false);
  assert.equal(isInPayWeek('2026-09-20', WEEK), false);
});
