import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { priceInternWeek, reconcileInternPayRow, splitInternGross, type InternWeekPriceInput } from './intern-week-pay';

const H = 3600;
const WEEK = ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'];

function week(hoursByDow: number[], rates = [{ ratePhp: 200, effectiveFrom: '2026-01-01' }]): InternWeekPriceInput {
  return {
    days: WEEK.map((iso, i) => ({ iso, rawSec: (hoursByDow[i] ?? 0) * H })),
    rates,
    dailyCapHours: 5,
    weeklyCapHours: 5,
  };
}

test('daily cap first, then the weekly cap on the capped sum', () => {
  // 6h Mon + 6h Tue → 5 + 5 by the daily cap → 5.00 paid by the weekly cap; 7.00 capped off.
  const r = priceInternWeek(week([0, 6, 6, 0, 0, 0, 0]));
  assert.ok(r.ok);
  assert.equal(r.hoursRaw, 12);
  assert.equal(r.hoursPaid, 5);
  assert.equal(r.cappedOffHours, 7);
  assert.equal(r.payPhp, 1000);
  // The weekly cap is consumed chronologically: Monday takes the whole allowance.
  assert.equal(r.hoursByDay['2026-08-31'].paid, 5);
  assert.equal(r.hoursByDay['2026-09-01'].paid, 0);
});

test('never overtime, never a premium: 20 raw hours pay exactly cap × rate', () => {
  const r = priceInternWeek(week([0, 4, 4, 4, 4, 4, 0]));
  assert.ok(r.ok);
  assert.equal(r.hoursPaid, 5);
  assert.equal(r.payPhp, 1000);
  assert.equal(r.cappedOffHours, 15);
  // The type carries no OT leg at all.
  assert.equal('otPay' in r, false);
});

test('a full 5-hour week under the caps pays every hour', () => {
  const r = priceInternWeek(week([0, 1, 1, 1, 1, 1, 0]));
  assert.ok(r.ok);
  assert.equal(r.hoursPaid, 5);
  assert.equal(r.payPhp, 1000);
  assert.equal(r.cappedOffHours, 0);
});

test('the rate is the newest row effective on or before the day; a mid-week change prices per day', () => {
  const rates = [
    { ratePhp: 200, effectiveFrom: '2026-01-01' },
    { ratePhp: 220, effectiveFrom: '2026-09-02' }, // Wednesday
  ];
  const r = priceInternWeek(week([0, 1, 1, 1, 1, 1, 0], rates));
  assert.ok(r.ok);
  // Mon + Tue at 200, Wed + Thu + Fri at 220 = 400 + 660
  assert.equal(r.payPhp, 1060);
  assert.equal(r.mixedRates, true);
  assert.equal(r.hoursByDay['2026-08-31'].ratePhp, 200);
  assert.equal(r.hoursByDay['2026-09-02'].ratePhp, 220);
  // ratePhp reports the rate in force on the LAST paid day.
  assert.equal(r.ratePhp, 220);
});

test('a rate effective after the week does not apply to it', () => {
  const r = priceInternWeek(week([0, 1, 0, 0, 0, 0, 0], [
    { ratePhp: 200, effectiveFrom: '2026-01-01' },
    { ratePhp: 999, effectiveFrom: '2026-09-06' },
  ]));
  assert.ok(r.ok);
  assert.equal(r.payPhp, 200);
});

test('no rate effective for any paid day → REFUSED, never ₱0', () => {
  const r = priceInternWeek(week([0, 1, 0, 0, 0, 0, 0], [{ ratePhp: 200, effectiveFrom: '2026-09-06' }]));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'no_rate_for_week');
});

test('no rate at all but no hours either prices to ₱0 without refusing (nothing to price)', () => {
  const r = priceInternWeek(week([0, 0, 0, 0, 0, 0, 0], []));
  assert.ok(r.ok);
  assert.equal(r.payPhp, 0);
  assert.equal(r.hoursPaid, 0);
  assert.equal(r.ratePhp, null);
});

test('2dp hours per day BEFORE pricing (the sheet convention)', () => {
  // 1.005h → 1.01 → ₱202.00 at ₱200
  const r = priceInternWeek(week([0, 1.005, 0, 0, 0, 0, 0]));
  assert.ok(r.ok);
  assert.equal(r.hoursByDay['2026-08-31'].paid, 1.01);
  assert.equal(r.payPhp, 202);
});

test('negative hours are refused', () => {
  const r = priceInternWeek(week([0, -1, 0, 0, 0, 0, 0]));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'negative_hours');
});

test('a week with a duplicate day or more than seven days is refused', () => {
  const dup = priceInternWeek({ ...week([0, 1, 0, 0, 0, 0, 0]), days: [{ iso: '2026-08-31', rawSec: H }, { iso: '2026-08-31', rawSec: H }] });
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.equal(dup.code, 'bad_week_shape');
  const eight = priceInternWeek({ ...week([0, 1, 0, 0, 0, 0, 0]), days: [...WEEK, '2026-09-06'].map((iso) => ({ iso, rawSec: H })) });
  assert.equal(eight.ok, false);
});

test('an empty week refuses (nothing to describe) rather than inventing a zero', () => {
  const r = priceInternWeek({ ...week([]), days: [] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'bad_week_shape');
});

test('shares always sum EXACTLY to gross — the intern share is the remainder', () => {
  assert.deepEqual(splitInternGross(1000.01, 50), { orphanagePhp: 500.01, internPhp: 500 });
  assert.deepEqual(splitInternGross(1000, 50), { orphanagePhp: 500, internPhp: 500 });
  assert.deepEqual(splitInternGross(333.33, 50), { orphanagePhp: 166.67, internPhp: 166.66 });
  assert.deepEqual(splitInternGross(1000, 0), { orphanagePhp: 0, internPhp: 1000 });
  assert.deepEqual(splitInternGross(1000, 100), { orphanagePhp: 1000, internPhp: 0 });
  for (const g of [0.01, 1.99, 123.45, 9999.99]) {
    const s = splitInternGross(g, 50);
    assert.equal(Math.round((s.orphanagePhp + s.internPhp) * 100), Math.round(g * 100));
  }
});

test('reconcile: a row that matches its own hours × rates is ok', () => {
  const r = reconcileInternPayRow({
    hours_by_day: { '2026-08-31': { paid: 3, rate_php: 200 }, '2026-09-01': { paid: 2, rate_php: 200 } },
    pay_php: 1000, pab_php: 0, gross_php: 1000, orphanage_share_pct: 50, orphanage_share_php: 500, intern_share_php: 500,
  });
  assert.equal(r.status, 'ok');
});

test('reconcile: a hand-altered stored pay is reported with the delta, never rewritten', () => {
  const r = reconcileInternPayRow({
    hours_by_day: { '2026-08-31': { paid: 5, rate_php: 200 } },
    pay_php: 1200, pab_php: 0, gross_php: 1200, orphanage_share_pct: 50, orphanage_share_php: 600, intern_share_php: 600,
  });
  assert.equal(r.status, 'pay_mismatch');
  assert.equal(r.deltaPhp, 200);
  assert.equal(r.expectedPayPhp, 1000);
});

test('reconcile: shares that drift from the percentage are caught', () => {
  const r = reconcileInternPayRow({
    hours_by_day: { '2026-08-31': { paid: 5, rate_php: 200 } },
    pay_php: 1000, pab_php: 1000, gross_php: 2000, orphanage_share_pct: 50, orphanage_share_php: 900, intern_share_php: 1100,
  });
  assert.equal(r.status, 'share_mismatch');
  assert.equal(r.expectedOrphanagePhp, 1000);
});
