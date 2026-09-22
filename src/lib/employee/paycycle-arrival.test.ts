import test from 'node:test';
import assert from 'node:assert/strict';
import { PROCESSOR_OPTIONS } from '@/lib/employee-payment-processors';
import {
  ARRIVAL_DAY_BY_RAIL,
  ARRIVAL_NOTE,
  TUESDAY,
  WEDNESDAY,
  arrivalDayForRail,
  arrivalDayName,
  arrivalGroups,
  arrivalRows,
} from './paycycle-arrival';

test('EVERY rail has a day — a new processor cannot inherit someone else\'s silently', () => {
  // The Record<ProcessorId, …> type already makes this a compile error, but the
  // union is inferred from a `as const` array: widen that array and inference
  // can quietly follow. This is the runtime tripwire behind the type.
  for (const p of PROCESSOR_OPTIONS) {
    assert.ok(
      ARRIVAL_DAY_BY_RAIL[p.id] !== undefined,
      `${p.id} (${p.label}) has no arrival day — add one to ARRIVAL_DAY_BY_RAIL`,
    );
  }
  assert.equal(Object.keys(ARRIVAL_DAY_BY_RAIL).length, PROCESSOR_OPTIONS.length);
});

test('wires is the only rail that is not Tuesday', () => {
  // Kane's ruling, 2026-09-22. Kept as an explicit assertion rather than a loop
  // so changing a day is a deliberate edit to a named expectation.
  assert.equal(ARRIVAL_DAY_BY_RAIL.wires, WEDNESDAY);
  assert.equal(ARRIVAL_DAY_BY_RAIL.hurupay, TUESDAY);
  assert.equal(ARRIVAL_DAY_BY_RAIL.higlobe, TUESDAY);
  assert.equal(ARRIVAL_DAY_BY_RAIL.wise, TUESDAY);
  assert.equal(ARRIVAL_DAY_BY_RAIL.wepay, TUESDAY);
  assert.equal(ARRIVAL_DAY_BY_RAIL.jeeves, TUESDAY);
});

test('an unset rail returns null and is NOT defaulted to Tuesday', () => {
  // Someone who has not chosen a payout method must be told the Friday promise
  // and nothing more specific — a guessed day is an invented claim about money.
  assert.equal(arrivalDayForRail(null), null);
  assert.equal(arrivalDayForRail(undefined), null);
  assert.equal(arrivalDayForRail('wires'), WEDNESDAY);
});

test('day names are the real ones', () => {
  assert.equal(arrivalDayName(TUESDAY), 'Tuesday');
  assert.equal(arrivalDayName(WEDNESDAY), 'Wednesday');
});

test('rows use the DISPLAY label, so the Kolan rebrand reaches this note', () => {
  // `hurupay` is the stored id forever; only the label rebranded (2026-08-24).
  // The employee must never be shown the word "hurupay".
  const labels = arrivalRows().map((r) => r.label);
  assert.ok(labels.includes('Kolan'));
  assert.ok(!labels.includes('hurupay'));
  assert.ok(!labels.some((l) => l.toLowerCase().includes('hurupay')));
});

test('groups collapse identical days and come out in day order', () => {
  const groups = arrivalGroups();
  assert.equal(groups.length, 2);
  assert.equal(groups[0].dayName, 'Tuesday');
  assert.equal(groups[1].dayName, 'Wednesday');
  assert.deepEqual(groups[1].labels, ['Wires']);
  assert.equal(groups[0].labels.length, 5);
  // Every rail appears exactly once across the groups.
  const flat = groups.flatMap((g) => g.labels);
  assert.equal(flat.length, PROCESSOR_OPTIONS.length);
  assert.equal(new Set(flat).size, PROCESSOR_OPTIONS.length);
});

test('the note promises FRIDAY and names no specific date', () => {
  // The Pay Stubs pane one section away prints the real payDate from
  // resolvePayDateIso. Two dates on one screen that disagree is worse than one
  // date, so this copy stays generic on purpose.
  const all = `${ARRIVAL_NOTE.headline} ${ARRIVAL_NOTE.body} ${ARRIVAL_NOTE.expect}`;
  assert.ok(/Friday/.test(ARRIVAL_NOTE.headline));
  assert.ok(/Friday/.test(ARRIVAL_NOTE.expect));
  assert.ok(!/\b\d{4}-\d{2}-\d{2}\b/.test(all), 'the note must not carry an ISO date');
  assert.ok(!/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/.test(all));
});

test('the note frames an early arrival as processing time, never as the payday', () => {
  assert.ok(/processing/i.test(ARRIVAL_NOTE.body));
  assert.ok(/not an earlier payday/i.test(ARRIVAL_NOTE.body));
});
