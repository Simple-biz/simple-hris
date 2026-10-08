/**
 * Run: node --import tsx --test src/lib/accounting-scoreboard/problem-grid-clear.test.ts
 *
 * Kane's W0.2 ruling (a), 2026-10-07: Monday 10-05's untyped Payroll Problems (old-grid counts) are cleared by a
 * script and re-logged with types. These are the refusals that keep that script to exactly what was ruled.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRID_CUTOFF, RULED_WEEKS, planGridClear, type GridEntry } from './problem-grid-clear';

const ROW1 = '11111111-1111-4111-8111-111111111111';
const ROW2 = '22222222-2222-4222-8222-222222222222';
const ROW3 = '33333333-3333-4333-8333-333333333333';

/** Production's week of 2026-10-04 as measured read-only on 2026-10-08: three counts, all Monday. */
const OCT5: GridEntry[] = [
  { rowId: ROW2, date: '2026-10-05', slot: 'day', value: 4, updatedAt: '2026-10-05T21:11:54Z' },
  { rowId: ROW3, date: '2026-10-05', slot: 'day', value: 0, updatedAt: '2026-10-06T13:28:06Z' },
  { rowId: ROW1, date: '2026-10-05', slot: 'day', value: 2, updatedAt: '2026-10-05T21:12:33Z' },
];

test('the ruled week clears its three Monday counts: 6 problems, the typed 0 included', () => {
  const plan = planGridClear('2026-10-04', OCT5);
  assert.ok(plan.ok, plan.ok ? '' : plan.refusal);
  if (!plan.ok) return;
  assert.equal(plan.entries.length, 3);
  assert.equal(plan.total, 6);
  assert.deepEqual(plan.byDay, [{ date: '2026-10-05', entries: 3, total: 6 }]);
  // Rows are named by a short id, never a label (a row label is a person's name).
  assert.deepEqual(
    plan.byRow.map((r) => [r.row, r.entries, r.total]),
    [
      ['11111111', 1, 2],
      ['22222222', 1, 4],
      ['33333333', 1, 0],
    ],
  );
});

test('only a week Kane ruled can be cleared', () => {
  assert.deepEqual(RULED_WEEKS, ['2026-10-04']);
  const old = planGridClear('2026-09-27', [{ ...OCT5[0], date: '2026-09-29' }]);
  assert.equal(old.ok, false);
  assert.match(old.ok ? '' : old.refusal, /not a week Kane ruled/);
});

test('the week must be a Sunday key', () => {
  const monday = planGridClear('2026-10-05', OCT5);
  assert.equal(monday.ok, false);
  assert.match(monday.ok ? '' : monday.refusal, /Sunday/);
  assert.equal(planGridClear('10/04/2026', OCT5).ok, false);
});

test('an empty week is refused: nothing to clear is never reported as cleared', () => {
  const none = planGridClear('2026-10-04', []);
  assert.equal(none.ok, false);
  assert.match(none.ok ? '' : none.refusal, /no old-grid/);
});

test('any entry saved at or after the round-3 apply is refused: it is not an old-grid count', () => {
  assert.equal(GRID_CUTOFF, '2026-10-06T18:04:00Z');
  const late = planGridClear('2026-10-04', [...OCT5, { rowId: ROW1, date: '2026-10-06', slot: 'day', value: 1, updatedAt: '2026-10-06T18:04:00Z' }]);
  assert.equal(late.ok, false);
  assert.match(late.ok ? '' : late.refusal, /round-3/);
  const later = planGridClear('2026-10-04', [{ ...OCT5[0], updatedAt: '2026-10-07T09:00:00.123+00:00' }]);
  assert.equal(later.ok, false);
});

test('an entry outside the week, or in any slot but the grid day count, is refused, never skipped', () => {
  const outside = planGridClear('2026-10-04', [...OCT5, { ...OCT5[0], date: '2026-10-11' }]);
  assert.equal(outside.ok, false);
  assert.match(outside.ok ? '' : outside.refusal, /outside the week/);
  const slot = planGridClear('2026-10-04', [...OCT5, { ...OCT5[0], slot: 'am' }]);
  assert.equal(slot.ok, false);
  assert.match(slot.ok ? '' : slot.refusal, /slot/);
});

test('an unreadable timestamp is refused rather than guessed', () => {
  const bad = planGridClear('2026-10-04', [{ ...OCT5[0], updatedAt: 'yesterday' }]);
  assert.equal(bad.ok, false);
});
