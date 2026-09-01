/**
 * Pins the PAB step tab's visibility gate to the money gate.
 *
 * The tab shows on exactly the file week whose dispatch carries the Perfect
 * Attendance Bonus — `isFinalPabWeek` containment over the week's owning-month
 * period end. If these fail, the wizard is either hiding the step on the week
 * PAB money moves, or showing a forgive/ignore surface on a week that pays none.
 *
 * Run: npx tsx --test src/lib/payroll/pab-payout-week.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isPabPayoutWeekForRange } from './pab-payout-week';
import type { PabOverridesMap } from '@/lib/pab-period-settings';

const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);

/** The live 2026-08 shape: Accounting's override runs Sun Aug 2 → Sat Aug 29. */
const AUG_OVERRIDE: PabOverridesMap = new Map([
  ['2026-08', { start: d(2026, 8, 2), end: d(2026, 8, 29) }],
]);

test('true for exactly the file week CONTAINING the period end (Aug 23–29 for a period ending Aug 29)', () => {
  assert.equal(isPabPayoutWeekForRange(d(2026, 8, 23), d(2026, 8, 29), AUG_OVERRIDE, null), true);
});

test('false for the week AFTER the period end — containment, never weekEnd >= periodEnd', () => {
  // Aug 30 – Sep 5 is when Accounting RUNS the payout (arrears), but the file
  // week that carries the money — and therefore the tab — is Aug 23–29.
  assert.equal(isPabPayoutWeekForRange(d(2026, 8, 30), d(2026, 9, 5), AUG_OVERRIDE, null), false);
});

test('false for a mid-period week', () => {
  assert.equal(isPabPayoutWeekForRange(d(2026, 8, 16), d(2026, 8, 22), AUG_OVERRIDE, null), false);
});

test("period resolves from the WEEK's owning month — a Sunday file-start owns the NEXT day's month", () => {
  // Aug 30 (Sunday) owns Monday Aug 31 → August. With no August override the
  // code default (Mon Aug 3 → Fri Sep 4) applies and Sep 4 falls inside this
  // week — the pab-calendars-sun-sat-sweep landmine: an un-overridden month
  // moves the payout week. This documents that the gate follows the money when
  // that happens, rather than inventing its own window.
  assert.equal(isPabPayoutWeekForRange(d(2026, 8, 30), d(2026, 9, 5), new Map(), null), true);
});

test('September 2026 with no override defaults to Mon Sep 7 → Fri Oct 2, so Sep 27–Oct 3 is the payout week', () => {
  assert.equal(isPabPayoutWeekForRange(d(2026, 9, 27), d(2026, 10, 3), new Map(), null), true);
  assert.equal(isPabPayoutWeekForRange(d(2026, 9, 20), d(2026, 9, 26), new Map(), null), false);
});

test('a valid legacy manual range end outranks the month override — mirroring the dispatch memo', () => {
  assert.equal(
    isPabPayoutWeekForRange(d(2026, 8, 30), d(2026, 9, 5), AUG_OVERRIDE, d(2026, 9, 5)),
    true,
  );
  assert.equal(
    isPabPayoutWeekForRange(d(2026, 8, 23), d(2026, 8, 29), AUG_OVERRIDE, d(2026, 9, 5)),
    false,
  );
});

test('an unparseable / absent week is never the payout week', () => {
  assert.equal(isPabPayoutWeekForRange(null, d(2026, 8, 29), AUG_OVERRIDE, null), false);
  assert.equal(isPabPayoutWeekForRange(d(2026, 8, 23), null, AUG_OVERRIDE, null), false);
});
