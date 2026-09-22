/**
 * The Payroll Wizard's Managers-Weekly amount (Kane, 2026-09-22).
 *
 * The claim worth pinning: the wizard withholds MONTHLY components outside the
 * final week and withholds NOTHING ELSE — in particular it must stop discarding
 * the Bonus Library amount folded into `calculated_bonus`, which is what the old
 * full recompute did.
 *
 * Run:  npx tsx --test src/lib/hsl-bonus/manager-week-amount.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { managerWeekAmount } from './manager-week-amount';
import { calcManagerBonus } from './schema';

// gyd@ is the clearest subject: ONE component, monthly, ₱25,000.
const GYD = 'gyd@simple.biz';
const MID_WEEK = '2026-09-06'; // not the month's final payroll week
const FINAL_WEEK = '2026-09-27';
const TICKED = { monthly_bonus: true };

test('the monthly component is withheld mid-month and paid in the final week', () => {
  assert.equal(
    calcManagerBonus(GYD, TICKED, { periodStart: MID_WEEK, includeMonthly: true }),
    25000,
    'the stored figure is always month-inclusive',
  );

  const mid = managerWeekAmount({
    storedBonus: 25000,
    email: GYD,
    kpiData: TICKED,
    periodStart: MID_WEEK,
    isFinalWeek: false,
  });
  assert.equal(mid.amount, 0);
  assert.equal(mid.monthlyWithheld, 25000);
  assert.equal(mid.inconsistent, false);

  const final = managerWeekAmount({
    storedBonus: 25000,
    email: GYD,
    kpiData: TICKED,
    periodStart: FINAL_WEEK,
    isFinalWeek: true,
  });
  assert.equal(final.amount, 25000);
  assert.equal(final.monthlyWithheld, 0);
});

test('A CATALOG BONUS SURVIVES — the bug this module exists for', () => {
  // The card stored ₱25,000 spec + ₱4,000 of Bonus Library bonus.
  const kpi = { ...TICKED, 'catalog:b1': true };
  const stored = 29000;

  // What the wizard used to do: throw the stored figure away and recompute.
  const oldBehaviour = calcManagerBonus(GYD, kpi, { periodStart: FINAL_WEEK, includeMonthly: true });
  assert.equal(oldBehaviour, 25000, 'calcManagerBonus cannot see a catalog: key — the ₱4,000 vanished');

  const final = managerWeekAmount({
    storedBonus: stored,
    email: GYD,
    kpiData: kpi,
    periodStart: FINAL_WEEK,
    isFinalWeek: true,
  });
  assert.equal(final.amount, 29000, 'the catalog amount is paid');

  // And mid-month only the MONTHLY spec component comes off — the catalog
  // bonus is weekly and keeps paying.
  const mid = managerWeekAmount({
    storedBonus: stored,
    email: GYD,
    kpiData: kpi,
    periodStart: MID_WEEK,
    isFinalWeek: false,
  });
  assert.equal(mid.amount, 4000);
  assert.equal(mid.monthlyWithheld, 25000);
});

test('a manager with no monthly components is paid the stored figure every week', () => {
  // eulap@ has only weekly `check` components.
  const kpi = { csm_9000: true, rfc_dme_75: true }; // 2500 + 2500
  for (const [periodStart, isFinalWeek] of [[MID_WEEK, false], [FINAL_WEEK, true]] as const) {
    const r = managerWeekAmount({
      storedBonus: 5000,
      email: 'eulap@simple.biz',
      kpiData: kpi,
      periodStart,
      isFinalWeek,
    });
    assert.equal(r.amount, 5000);
    assert.equal(r.monthlyWithheld, 0);
  }
});

test('an unknown email has no spec, so nothing is withheld and the stored figure stands', () => {
  const r = managerWeekAmount({
    storedBonus: 1200,
    email: 'nobody@simple.biz',
    kpiData: { 'catalog:b1': true },
    periodStart: MID_WEEK,
    isFinalWeek: false,
  });
  assert.equal(r.amount, 1200);
  assert.equal(r.monthlyWithheld, 0);
});

test('a stored figure smaller than its monthly components is clamped AND flagged', () => {
  // Only reachable if something other than `scoreEntry` wrote the row — a
  // negative KPI bonus would be a silent pay CUT, so it clamps and says so.
  const r = managerWeekAmount({
    storedBonus: 1000,
    email: GYD,
    kpiData: TICKED,
    periodStart: MID_WEEK,
    isFinalWeek: false,
  });
  assert.equal(r.amount, 0);
  assert.equal(r.inconsistent, true);
});

test('an absent or unusable stored figure reads as zero, never NaN', () => {
  for (const storedBonus of [null, undefined, Number.NaN]) {
    const r = managerWeekAmount({
      storedBonus,
      email: 'eulap@simple.biz',
      kpiData: {},
      periodStart: MID_WEEK,
      isFinalWeek: false,
    });
    assert.equal(r.amount, 0);
    assert.equal(r.inconsistent, false);
  }
});
