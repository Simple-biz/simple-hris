import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAdjustmentAmount,
  adjustmentToPhp,
  adjustmentDupKey,
  combineAdjustments,
  combineAdjustmentTexts,
  formatAdjustmentText,
  isBoardDerivedTotal,
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

// ── combineAdjustments ───────────────────────────────────────────────────────
// Several rows, one worker, one pay week. The rule (kaner, 2026-07-29): DIFFERENT
// amounts add up; the SAME amount repeated is counted once and flagged as a
// suspected duplicate. Getting this wrong pays somebody twice or short.

const FX = { usdToPhp: 56, usdToCop: 4000 };
/** A contribution as the wizard builds it, from board text. */
const c = (text: string) => {
  const parsed = parseAdjustmentAmount(text)!;
  return { text, parsed, php: adjustmentToPhp(parsed, FX)! };
};

test('different amounts are added, signed — a bonus and a deduction net out', () => {
  const combined = combineAdjustments([c('+500'), c('-200')]);
  assert.equal(combined.total, 300);
  assert.equal(combined.counted.length, 2);
  assert.equal(combined.duplicates.length, 0);
  assert.deepEqual(combined.runningTotals, [500, 300]);
});

test('cents survive a sum (no float dust reaching a pay stub)', () => {
  const combined = combineAdjustments([c('1850.55'), c('-250.50'), c('0.05')]);
  assert.equal(combined.total, 1600.1);
});

test('an identical amount repeated is counted ONCE and reported', () => {
  const combined = combineAdjustments([c('+500'), c('+500')]);
  assert.equal(combined.total, 500, 'never 1000 — the repeat is presumed a duplicate');
  assert.equal(combined.counted.length, 1);
  assert.deepEqual(
    combined.duplicates.map((d) => d.text),
    ['+500'],
  );
});

test('a repeat among genuinely different amounts drops out, the rest still add', () => {
  // 500 · 500 (dup) · -200  →  500 - 200
  const combined = combineAdjustments([c('500'), c('500'), c('-200')]);
  assert.equal(combined.total, 300);
  assert.equal(combined.counted.length, 2);
  assert.equal(combined.duplicates.length, 1);
});

test('"the same amount" means same currency AND same figure', () => {
  // $8.93 ≈ ₱500 at these rates, but it is plainly a different note.
  assert.notEqual(adjustmentDupKey(parseAdjustmentAmount('500')!), adjustmentDupKey(parseAdjustmentAmount('$8.93')!));
  const combined = combineAdjustments([c('500'), c('$8.93')]);
  assert.equal(combined.counted.length, 2);
  assert.equal(combined.duplicates.length, 0);
  assert.equal(combined.total, 1000.08);
});

test('mixed currencies add up in PHP at the given rates', () => {
  const combined = combineAdjustments([c('500'), c('$50'), c('COP 50,000')]);
  assert.equal(combined.total, 500 + 2800 + 700);
});

test('a single row behaves exactly as it always did', () => {
  const combined = combineAdjustments([c('-₱900')]);
  assert.equal(combined.total, -900);
  assert.equal(combined.duplicates.length, 0);
  assert.deepEqual(combined.runningTotals, [-900]);
});

test('the total does not depend on row order', () => {
  const a = combineAdjustments([c('500'), c('-200'), c('75.25')]).total;
  const b = combineAdjustments([c('75.25'), c('500'), c('-200')]).total;
  assert.equal(a, b);
});

// ── isBoardDerivedTotal ──────────────────────────────────────────────────────
// The merge-only pull upgrades an override it recognises as its own earlier
// output, and refuses to touch anything else. This is the guard that keeps a
// hand-typed figure safe while still letting "add them together" take effect.

test('recognises the total, every earlier running total, and any single row', () => {
  const combined = combineAdjustments([c('500'), c('600')]);
  assert.equal(combined.total, 1100);
  assert.ok(isBoardDerivedTotal(1100, combined), 'the total itself');
  assert.ok(isBoardDerivedTotal(500, combined), 'what the board held before the 2nd row');
  assert.ok(isBoardDerivedTotal(500.004, combined), 'sub-cent float drift still matches');
  // The pre-2026-07-29 rule applied the NEWEST row alone, so that value has to
  // be recognised too or the week found short (₱4,750 saved vs ₱6,600 owed)
  // would never self-heal.
  assert.ok(isBoardDerivedTotal(600, combined), 'the newest row alone — what the old rule applied');
  assert.ok(!isBoardDerivedTotal(1234, combined), 'a hand-typed figure is left alone');
  assert.ok(!isBoardDerivedTotal(0.5, combined), 'nor a near-zero placeholder');
});

test('a dropped duplicate still counts as a board-derived value', () => {
  // The old rule could have applied either twin; both must be recognised.
  const combined = combineAdjustments([c('8450'), c('8450')]);
  assert.ok(isBoardDerivedTotal(8450, combined));
  assert.ok(!isBoardDerivedTotal(16900, combined), 'the doubled figure is NOT something this board produced');
});

// ── combineAdjustmentTexts (retract path) ────────────────────────────────────
// The board works in raw text; a removal hands the wizard the survivors so it
// can SUBTRACT the removed row instead of clearing the whole override.

test('removing one of two summed rows leaves the other standing', () => {
  const before = combineAdjustmentTexts(['+600', '+500'], FX); // survivor + removed
  const remaining = combineAdjustmentTexts(['+600'], FX);
  assert.equal(before.total, 1100);
  assert.equal(remaining.total, 600);
});

test('removing a DUPLICATE row changes nothing (it was never added in)', () => {
  const before = combineAdjustmentTexts(['+500', '+500'], FX);
  const remaining = combineAdjustmentTexts(['+500'], FX);
  assert.equal(before.total, 500);
  assert.equal(remaining.total, 500, 'so the wizard must leave the override alone');
});

test('unparseable and unconvertible cells are ignored, not guessed at', () => {
  assert.equal(combineAdjustmentTexts(['+500', '-2 hrs', '', null, undefined], FX).total, 500);
  assert.equal(
    combineAdjustmentTexts(['$50'], { usdToPhp: 0, usdToCop: 4000 }).counted.length,
    0,
    'a missing rate contributes nothing rather than a garbage figure',
  );
});
