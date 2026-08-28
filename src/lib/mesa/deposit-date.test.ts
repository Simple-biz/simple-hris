import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MESA_DEPOSIT_WEEKDAY,
  MESA_WEEK_SPAN_DAYS,
  isoDayOfWeek,
  mesaDepositDateFor,
  mesaDepositDatesToReverse,
  mesaWeekStartFor,
} from './deposit-date';

// These tests exist because the MESA weekly deposit date used to be written in
// one place and matched in another, as two independent copies of the same
// expression. Moving one and not the other produces NO error: the reversal is a
// filtered DELETE, so a filter that matches nothing deletes nothing and reports
// success, leaving every member's ₱400 in their balance for a pay week that was
// cancelled. The contract below is what makes that impossible; if it changes,
// the reversal silently changes with it, so it is pinned here.

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Every date in [from, from + count) — enough to cover leap days, month ends,
 *  year boundaries and all seven weekday alignments many times over. */
function isoRange(from: string, count: number): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10),
  );
}

// A little over three years, spanning two leap years.
const EVERY_DATE = isoRange('2024-01-01', 1200);

test('the deposit date is ALWAYS a Friday, whatever weekday the week ends on', () => {
  for (const weekEnd of EVERY_DATE) {
    const deposit = mesaDepositDateFor(weekEnd);
    assert.equal(
      isoDayOfWeek(deposit),
      MESA_DEPOSIT_WEEKDAY,
      `weekEnd ${weekEnd} (${DAYS[isoDayOfWeek(weekEnd)]}) produced ${deposit} (${DAYS[isoDayOfWeek(deposit)]}), not a Friday`,
    );
  }
});

test('for a normal Sun–Sat week the deposit lands the day before the week end', () => {
  // 2026-08-29 is a Saturday.
  assert.equal(isoDayOfWeek('2026-08-29'), 6);
  assert.equal(mesaDepositDateFor('2026-08-29'), '2026-08-28');
  assert.equal(isoDayOfWeek('2026-08-28'), MESA_DEPOSIT_WEEKDAY);
});

test('an 8-day Sun→Sun span still yields a Friday, not a Saturday', () => {
  // Production carries both 7- and 8-day filename ranges: the span is
  // deliberately unchecked upstream. A naive `weekEnd - 1` would return the
  // Saturday here and quietly reintroduce the wrong-day bug.
  const sunday = '2026-08-30';
  assert.equal(isoDayOfWeek(sunday), 0);
  const deposit = mesaDepositDateFor(sunday);
  assert.equal(deposit, '2026-08-28');
  assert.equal(isoDayOfWeek(deposit), MESA_DEPOSIT_WEEKDAY);
  assert.notEqual(deposit, '2026-08-29', 'must not be the Saturday');
});

test('a week end that is already a Friday is left alone', () => {
  assert.equal(isoDayOfWeek('2026-08-28'), 5);
  assert.equal(mesaDepositDateFor('2026-08-28'), '2026-08-28');
});

test('THE INVARIANT: what the reverser matches always includes what the writer wrote', () => {
  // This is the whole point of the module. If it ever fails, deleting a pay
  // week silently orphans that week's deposits.
  for (const weekEnd of EVERY_DATE) {
    const written = mesaDepositDateFor(weekEnd);
    const matched = mesaDepositDatesToReverse(weekEnd);
    assert.ok(
      matched.includes(written),
      `weekEnd ${weekEnd}: writer produces ${written} but reverser looks for ${JSON.stringify(matched)}`,
    );
  }
});

test('the reverser also still matches pre-cutover deposits dated on the week end', () => {
  // Deposits written before the Friday move carry the week end itself. Dropping
  // this makes them permanently unreversible — the exact bug being fixed.
  const saturday = '2026-08-29';
  assert.ok(mesaDepositDatesToReverse(saturday).includes(saturday));
});

test('the reverser matches EXACT dates, never a range', () => {
  // A window match would also sweep up the historical deposits laid down by the
  // CSV backfill, which carry an identical shape (₱100/₱300, no tracker
  // provenance) and are not this week's to remove.
  for (const weekEnd of EVERY_DATE) {
    const matched = mesaDepositDatesToReverse(weekEnd);
    assert.ok(matched.length <= 2, `${weekEnd} produced ${matched.length} dates`);
    assert.equal(new Set(matched).size, matched.length, `${weekEnd} produced duplicates`);
  }
});

test('the deposit date always falls inside the dedupe window', () => {
  // Load-bearing for idempotency: the "already credited this week?" check scans
  // [weekStart, weekEnd]. A deposit dated outside it would be invisible to that
  // check and get written again on every single re-upload of the same week.
  for (const weekEnd of EVERY_DATE) {
    const deposit = mesaDepositDateFor(weekEnd);
    const weekStart = mesaWeekStartFor(weekEnd);
    assert.ok(
      deposit >= weekStart && deposit <= weekEnd,
      `weekEnd ${weekEnd}: deposit ${deposit} is outside [${weekStart}, ${weekEnd}]`,
    );
  }
});

test('the dedupe window spans exactly the Sun–Sat week', () => {
  assert.equal(MESA_WEEK_SPAN_DAYS, 6);
  assert.equal(mesaWeekStartFor('2026-08-29'), '2026-08-23');
  assert.equal(isoDayOfWeek('2026-08-23'), 0, 'a Saturday week end implies a Sunday start');
});

test('a malformed date is rejected rather than silently mis-dated', () => {
  // Failing loud beats writing a financial row on a date nobody meant.
  for (const bad of ['', '2026-8-29', '29/08/2026', '2026-08-29T00:00:00Z', 'not-a-date']) {
    assert.throws(() => mesaDepositDateFor(bad), /YYYY-MM-DD/, `accepted ${JSON.stringify(bad)}`);
  }
});
