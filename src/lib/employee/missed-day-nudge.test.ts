import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isNudgeableMissedDay,
  orderNudgeDays,
  NUDGE_INTERVAL_MS,
  type MissedDayCell,
} from './missed-day-nudge';

/**
 * A plain past weekday that fell short with real tracked hours — the one shape that
 * renders RED and is still actionable. Every case below flips exactly one field, so
 * a failure names the branch that broke.
 */
function redDay(over: Partial<MissedDayCell> = {}): MissedDayCell {
  return {
    inMonth: true,
    weekend: false,
    isHoliday: false,
    hasData: true,
    effectivelyPasses: false,
    isFutureOrToday: false,
    canRequestAdjust: true,
    hasRequest: false,
    ...over,
  };
}

test('the baseline red day is nudgeable', () => {
  assert.equal(isNudgeableMissedDay(redDay()), true);
});

/**
 * These six mirror the tone chain's branches in EmployeeMyHours.tsx, in order. Red is
 * what is LEFT after each of these is taken, so each must independently veto a nudge.
 * If one of these ever fails, the predicate and the tile's colour have diverged.
 */
test('every earlier branch of the tone chain vetoes the nudge', () => {
  const cases: ReadonlyArray<[string, Partial<MissedDayCell>]> = [
    ['a filler day from the adjacent month', { inMonth: false }],
    ['a US holiday (renders blue)', { isHoliday: true }],
    ['a weekend cell (non-HSL: display only, never scoring)', { weekend: true }],
    ['a passing or forgiven day (renders emerald)', { effectivelyPasses: true }],
    ['a day Hubstaff has not reported (renders sky/orange, NOT a miss)', { hasData: false }],
    ['today or later (today is in progress, renders orange)', { isFutureOrToday: true }],
  ];
  for (const [label, over] of cases) {
    assert.equal(isNudgeableMissedDay(redDay(over)), false, `should not nudge: ${label}`);
  }
});

test('a day the employee cannot file on is never nudged', () => {
  // The load-bearing term. A FUTURE day carrying partial data falls through the tone
  // chain to red, and canRequestAdjust is the only thing that excludes it.
  assert.equal(
    isNudgeableMissedDay(redDay({ isFutureOrToday: true, canRequestAdjust: false })),
    false,
  );
  assert.equal(isNudgeableMissedDay(redDay({ canRequestAdjust: false })), false);
});

test('a day that already has a request is not nudged, pending or decided', () => {
  assert.equal(isNudgeableMissedDay(redDay({ hasRequest: true })), false);
});

test('no-data days are excluded regardless of how they render', () => {
  // The dropped leading Sunday of an 8-day Sun->Sun export has no data at all
  // (docs/notes/hubstaff-sunday-overlap.md, root cause still open). Requiring real
  // hours closes that class by construction — assert it for both weekend and weekday
  // shapes, since the overlap bug lands on a Sunday.
  assert.equal(isNudgeableMissedDay(redDay({ hasData: false })), false);
  assert.equal(isNudgeableMissedDay(redDay({ hasData: false, weekend: true })), false);
});

test('orderNudgeDays is a permutation, never a mutation', () => {
  const input = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07'];
  const frozen = [...input];
  const out = orderNudgeDays(input);
  assert.deepEqual(input, frozen, 'input must not be mutated');
  assert.equal(out.length, input.length);
  assert.deepEqual([...out].sort(), [...input].sort(), 'same members, reordered');
});

test('orderNudgeDays is STABLE for the same set — the 5s cycle must not jump', () => {
  const isos = ['2026-09-02', '2026-09-08', '2026-09-15', '2026-09-21', '2026-09-29'];
  assert.deepEqual(orderNudgeDays(isos), orderNudgeDays(isos));
  // Order of the input must not change the deal either: the seed is the joined list,
  // and the caller always passes calendar order.
  assert.deepEqual(orderNudgeDays(isos), orderNudgeDays([...isos]));
});

test('orderNudgeDays actually reorders, and differs between months', () => {
  const sept = ['2026-09-02', '2026-09-08', '2026-09-15', '2026-09-21', '2026-09-29', '2026-09-30'];
  const oct = ['2026-10-02', '2026-10-08', '2026-10-15', '2026-10-21', '2026-10-29', '2026-10-30'];
  assert.notDeepEqual(orderNudgeDays(sept), sept, 'a 6-item deal should not be the identity');
  // Different sets deal differently — same-shaped months must not share an order.
  assert.notDeepEqual(
    orderNudgeDays(sept).map((d) => d.slice(-2)),
    orderNudgeDays(oct).map((d) => d.slice(-2)),
  );
});

test('orderNudgeDays handles the degenerate sizes', () => {
  assert.deepEqual(orderNudgeDays([]), []);
  assert.deepEqual(orderNudgeDays(['2026-09-02']), ['2026-09-02']);
});

test('the interval is the 5 seconds Kane asked for', () => {
  assert.equal(NUDGE_INTERVAL_MS, 5000);
});
