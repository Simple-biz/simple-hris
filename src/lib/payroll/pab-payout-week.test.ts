/**
 * Pins THE PAB PAYOUT RULE (Kane, 2026-09-08): the bonus pays on the payroll
 * week AFTER the one that closes the period — never combined with it.
 *
 * These tests also pin the half that is easy to miss: the payout week usually
 * belongs to the NEXT owning month, so the paid month must be read off the
 * CLOSING week. If `pabMonthPaidByWeek` regresses, September's period pays
 * October's (unfinished) bonus, or nothing at all.
 *
 * Run: npx tsx --test src/lib/payroll/pab-payout-week.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isPabPayoutWeekForRange,
  pabMonthPaidByWeek,
  pabPayoutForWeek,
  pabPayoutWeekForPeriodEnd,
} from './pab-payout-week';
import type { PabOverridesMap } from '@/lib/pab-period-settings';

const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);
const iso = (x: Date) => x.toLocaleDateString('en-CA');

/** The live 2026 shape: Accounting's overrides as held in `pab_period_overrides`. */
const OVERRIDES: PabOverridesMap = new Map([
  ['2026-07', { start: d(2026, 7, 6), end: d(2026, 7, 31) }],
  ['2026-08', { start: d(2026, 8, 2), end: d(2026, 8, 29) }],
]);

test('the week AFTER the closing week pays — Aug 2–29 pays on Aug 30 – Sep 5', () => {
  assert.equal(isPabPayoutWeekForRange(d(2026, 8, 30), d(2026, 9, 5), OVERRIDES, null), true);
});

test('the closing week itself does NOT pay — never combined with the period end', () => {
  // Aug 23–29 CONTAINS the period end. Under the old containment rule this was
  // the payout week; it is now the last week of the period.
  assert.equal(isPabPayoutWeekForRange(d(2026, 8, 23), d(2026, 8, 29), OVERRIDES, null), false);
});

test('exactly one week pays — the week after the payout week does not', () => {
  assert.equal(isPabPayoutWeekForRange(d(2026, 9, 6), d(2026, 9, 12), OVERRIDES, null), false);
});

test('a mid-period week never pays', () => {
  assert.equal(isPabPayoutWeekForRange(d(2026, 8, 16), d(2026, 8, 22), OVERRIDES, null), false);
});

test('July (Jul 6–31) closes Jul 26 – Aug 1 and pays on Aug 2–8, still as JULY', () => {
  const v = pabPayoutForWeek(d(2026, 8, 2), d(2026, 8, 8), OVERRIDES, null);
  assert.equal(v.pays, true);
  // month is 0-indexed: 6 = July. Reading the month off Aug 2's own Monday
  // (Aug 3) would say August and pay the wrong period.
  assert.deepEqual({ year: v.year, month: v.month }, { year: 2026, month: 6 });
  assert.equal(iso(v.periodEnd), '2026-07-31');
});

test('August is the coincidence — paid month and the file week own month agree', () => {
  const v = pabPayoutForWeek(d(2026, 8, 30), d(2026, 9, 5), OVERRIDES, null);
  assert.equal(v.pays, true);
  assert.deepEqual({ year: v.year, month: v.month }, { year: 2026, month: 7 });
  assert.equal(iso(v.periodEnd), '2026-08-29');
});

test('September with no override defaults to Mon Sep 7 → Fri Oct 2, so Oct 4–10 pays it', () => {
  assert.equal(isPabPayoutWeekForRange(d(2026, 10, 4), d(2026, 10, 10), OVERRIDES, null), true);
  // The closing week — the one the OLD rule paid on.
  assert.equal(isPabPayoutWeekForRange(d(2026, 9, 27), d(2026, 10, 3), OVERRIDES, null), false);
  const v = pabPayoutForWeek(d(2026, 10, 4), d(2026, 10, 10), OVERRIDES, null);
  assert.deepEqual({ year: v.year, month: v.month }, { year: 2026, month: 8 }); // September
});

test('pabMonthPaidByWeek reads the CLOSING week, never the payout week own Monday', () => {
  assert.deepEqual(pabMonthPaidByWeek(d(2026, 10, 4)), { year: 2026, month: 8 }); // Sep, not Oct
  assert.deepEqual(pabMonthPaidByWeek(d(2026, 8, 2)), { year: 2026, month: 6 }); // Jul, not Aug
  assert.deepEqual(pabMonthPaidByWeek(d(2026, 8, 30)), { year: 2026, month: 7 }); // Aug
});

test('a valid legacy manual range end outranks the month override, and still pays a week later', () => {
  // Manual end Sep 5 → the closing week is Aug 30 – Sep 5 → payout is Sep 6–12.
  assert.equal(isPabPayoutWeekForRange(d(2026, 9, 6), d(2026, 9, 12), OVERRIDES, d(2026, 9, 5)), true);
  assert.equal(isPabPayoutWeekForRange(d(2026, 8, 30), d(2026, 9, 5), OVERRIDES, d(2026, 9, 5)), false);
});

test('an unparseable / absent week is never the payout week', () => {
  assert.equal(isPabPayoutWeekForRange(null, d(2026, 8, 29), OVERRIDES, null), false);
  assert.equal(isPabPayoutWeekForRange(d(2026, 8, 23), null, OVERRIDES, null), false);
});

test('pabPayoutWeekForPeriodEnd names the week the gate agrees pays', () => {
  const w = pabPayoutWeekForPeriodEnd(d(2026, 8, 29));
  assert.equal(iso(w.start), '2026-08-30');
  assert.equal(iso(w.end), '2026-09-05');
  assert.equal(isPabPayoutWeekForRange(w.start, w.end, OVERRIDES, null), true);

  // A period ending mid-week (the Mon→Fri default shape) lands the same way.
  const s = pabPayoutWeekForPeriodEnd(d(2026, 10, 2)); // Friday
  assert.equal(iso(s.start), '2026-10-04');
  assert.equal(iso(s.end), '2026-10-10');
});
