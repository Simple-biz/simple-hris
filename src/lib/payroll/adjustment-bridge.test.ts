import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAdjustmentAmount,
  adjustmentToPhp,
  formatAdjustmentText,
  payWeekStartFromSourceFile,
} from './adjustment-bridge';

// ── payWeekStartFromSourceFile ───────────────────────────────────────────────
// This is what tells the wizard's pull "this note belongs to the payroll I am
// running now" from "this note was applied in an earlier week and is history".
// Get it wrong in one direction and a week of adjustments is stranded behind a
// Done tick (the 2026-07-28 incident: 101 board rows against `bonusOverrides:
// {}`); wrong in the other and an already-paid adjustment is paid twice.

test('reads the pay-period Sunday out of a wizard batch filename', () => {
  assert.equal(
    payWeekStartFromSourceFile('simple-biz_daily_report_2026-07-19_to_2026-07-25.csv'),
    '2026-07-19',
  );
  // The board stamps notes on the period's SUNDAY, so a range that starts
  // mid-week still has to land on the same anchor.
  assert.equal(
    payWeekStartFromSourceFile('simple-biz_daily_report_2026-07-22_to_2026-07-28.csv'),
    '2026-07-19',
  );
});

test('no range in the filename → null (caller falls back to Done-only skipping)', () => {
  assert.equal(payWeekStartFromSourceFile('hand-named-upload.csv'), null);
  assert.equal(payWeekStartFromSourceFile(''), null);
  assert.equal(payWeekStartFromSourceFile(null), null);
  assert.equal(payWeekStartFromSourceFile(undefined), null);
});

test('the pay week compares equal to the board week_start it is matched against', () => {
  // A note written while paying Jul 19–25 carries week_start 2026-07-19; the
  // loaded CSV for that period must resolve to the identical string, since the
  // pull's eligibility test is a plain ===.
  const cycleWeek = payWeekStartFromSourceFile(
    'simple-biz_daily_report_2026-07-19_to_2026-07-25.csv',
  );
  assert.equal(cycleWeek, '2026-07-19');
  assert.ok(cycleWeek !== null && '2026-07-12' < cycleWeek, 'an earlier period sorts before it');
  assert.ok(cycleWeek !== null && '2026-07-26' > cycleWeek, 'a staged period sorts after it');
});

// ── parseAdjustmentAmount ────────────────────────────────────────────────────
// Deliberately strict: a half-understood cell silently changing someone's pay
// is worse than no autofill. These pin the boundary the board now warns about.

test('accepts a plain signed amount, defaulting to PHP', () => {
  assert.deepEqual(parseAdjustmentAmount('500'), { amount: 500, currency: 'PHP' });
  assert.deepEqual(parseAdjustmentAmount('+500'), { amount: 500, currency: 'PHP' });
  assert.deepEqual(parseAdjustmentAmount('-250.50'), { amount: -250.5, currency: 'PHP' });
  assert.deepEqual(parseAdjustmentAmount('-6,544.86'), { amount: -6544.86, currency: 'PHP' });
  assert.deepEqual(parseAdjustmentAmount('-₱900'), { amount: -900, currency: 'PHP' });
});

test('reads the currency marker on either side', () => {
  assert.deepEqual(parseAdjustmentAmount('$50'), { amount: 50, currency: 'USD' });
  assert.deepEqual(parseAdjustmentAmount('USD 50'), { amount: 50, currency: 'USD' });
  assert.deepEqual(parseAdjustmentAmount('COP 50,000'), { amount: 50000, currency: 'COP' });
  assert.deepEqual(parseAdjustmentAmount('50 USD'), { amount: 50, currency: 'USD' });
});

test('refuses prose and ambiguity — the board flags these instead of guessing', () => {
  assert.equal(parseAdjustmentAmount('+500 bonus'), null);
  assert.equal(parseAdjustmentAmount('-2 hrs'), null);
  assert.equal(parseAdjustmentAmount('₱50 USD'), null);
  assert.equal(parseAdjustmentAmount('1850 (rate change)'), null);
  assert.equal(parseAdjustmentAmount(''), null);
  assert.equal(parseAdjustmentAmount(null), null);
});

// ── round-trip ───────────────────────────────────────────────────────────────

test('a mirrored wizard amount parses back to itself', () => {
  for (const amount of [500, -250.5, 6167, -86.63, 0]) {
    const parsed = parseAdjustmentAmount(formatAdjustmentText(amount));
    assert.deepEqual(parsed, { amount, currency: 'PHP' }, `round-trip failed for ${amount}`);
  }
});

test('non-PHP amounts convert through USD; a missing rate autofills nothing', () => {
  const fx = { usdToPhp: 56, usdToCop: 4000 };
  assert.equal(adjustmentToPhp({ amount: 50, currency: 'USD' }, fx), 2800);
  assert.equal(adjustmentToPhp({ amount: 50000, currency: 'COP' }, fx), 700);
  assert.equal(adjustmentToPhp({ amount: 500, currency: 'PHP' }, fx), 500);
  assert.equal(adjustmentToPhp({ amount: 50, currency: 'USD' }, { usdToPhp: 0, usdToCop: 4000 }), null);
  assert.equal(adjustmentToPhp({ amount: 50000, currency: 'COP' }, { usdToPhp: 56, usdToCop: 0 }), null);
});
