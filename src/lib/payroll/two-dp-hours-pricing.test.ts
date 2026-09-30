import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  phpHourlyPayFromSeconds,
  pricesAtTwoDpHours,
  splitTwoDpHoursWeek,
  TWO_DP_HOURS_PRICING_FROM,
} from './money-php';
import { proratePayForMidPeriodChange } from './prorate-mid-period';
import { computeProratedRowPay } from './current-pay';
import type { RateHistoryByEmail } from './rate-history-resolve';

// ── The stub that started it (Kane, 2026-09-30) ─────────────────────────────
// imeer@, PM Team, week Sun Sep 20 – Sat Sep 26 2026, ₱285.00 / ₱427.50.
// 52:32:06 worked = 189,126 s. OT = 45,126 s = 12.535h EXACTLY.
//   whole seconds : 12.535 × 427.50 = ₱5,358.71, printed "12.54h × ₱427.50"
//   2dp hours     : 12.54  × 427.50 = ₱5,360.85, the line multiplies out
// Kane: "lets not use 4-5 decimals only 2 decimals!" → price the 2dp hours,
// forward from the Sep 27 pay week. Sep 20–26 keeps what it was staged at.

const EMAIL = 'imeer@simple.biz';
const TOTAL_SEC = 189_126;
const REG = 285;
const OT = 427.5;

/** Mon–Fri of the pay week starting on `sunday`, summing to 189,126 s. */
function weekDays(sunday: Date) {
  const secs = [37_825, 37_825, 37_825, 37_825, 37_826];
  return secs.map((seconds, i) => ({
    date: new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + 1 + i),
    seconds,
  }));
}
const OLD_WEEK = weekDays(new Date(2026, 8, 20));
const NEW_WEEK = weekDays(new Date(2026, 8, 27));

function hms(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** A Hubstaff row the way Dispatch reads it: one ISO column per worked day. */
function hubstaffRow(days: Array<{ date: Date; seconds: number }>): Record<string, unknown> {
  return Object.fromEntries(days.map((d) => [iso(d.date), hms(d.seconds)]));
}

test('fixture: the days sum to the stub and OT is exactly 12.535h', () => {
  assert.equal(NEW_WEEK.reduce((s, d) => s + d.seconds, 0), TOTAL_SEC);
  assert.equal(TOTAL_SEC - 40 * 3600, 45_126);
  assert.equal(45_126 / 3600, 12.535);
});

// ── The gate ────────────────────────────────────────────────────────────────

test('gate: the first 2dp pay week is Sun 2026-09-27; Sat 09-26 stays whole-seconds', () => {
  assert.equal(TWO_DP_HOURS_PRICING_FROM, '2026-09-27');
  assert.equal(new Date(2026, 8, 27).getDay(), 0, 'the cutover must be a Sunday (non-HSL week start)');
  assert.equal(pricesAtTwoDpHours(new Date(2026, 8, 26, 23, 59)), false);
  assert.equal(pricesAtTwoDpHours(new Date(2026, 8, 27)), true);
  assert.equal(pricesAtTwoDpHours(new Date(2026, 9, 3)), true);
});

test('gate: no date is not a new week', () => {
  assert.equal(pricesAtTwoDpHours(null), false);
  assert.equal(pricesAtTwoDpHours(undefined), false);
  assert.equal(pricesAtTwoDpHours(new Date('nope')), false);
});

// ── The split ───────────────────────────────────────────────────────────────

test('split: 189,126 s → 52.54 total, 40.00 regular, 12.54 OT, seconds on the 0.01h grid', () => {
  const two = splitTwoDpHoursWeek(TOTAL_SEC);
  assert.deepEqual(two, {
    totalHours: 52.54,
    regularHours: 40,
    otHours: 12.54,
    regularSec: 144_000,
    otSec: 45_144,
  });
  assert.equal(phpHourlyPayFromSeconds(REG, two.regularSec), 11_400);
  assert.equal(phpHourlyPayFromSeconds(OT, two.otSec), 5_360.85);
  assert.equal(phpHourlyPayFromSeconds(OT, two.otSec), Math.round(two.otHours * OT * 100) / 100);
});

test('split: an exact half rounds UP even where the float product lands on …4999', () => {
  // 522 s = 0.145h exactly; Math.round(0.145 × 100) / 100 is 0.14 in float64.
  assert.equal(Math.round((522 / 3600) * 100) / 100, 0.14, 'the float trap this guards');
  assert.equal(splitTwoDpHoursWeek(522).totalHours, 0.15);
  // 18 s past the cap is exactly 0.005h of OT.
  assert.equal(splitTwoDpHoursWeek(40 * 3600 + 18).otHours, 0.01);
  assert.equal(splitTwoDpHoursWeek(40 * 3600 + 17).otHours, 0);
});

test('split: under 40h is all regular; nothing worked is all zero', () => {
  const under = splitTwoDpHoursWeek(125_039); // 34.73306h
  assert.equal(under.regularHours, 34.73);
  assert.equal(under.otHours, 0);
  assert.equal(under.otSec, 0);
  for (const bad of [0, -5, Number.NaN]) {
    assert.deepEqual(splitTwoDpHoursWeek(bad), {
      totalHours: 0,
      regularHours: 0,
      otHours: 0,
      regularSec: 0,
      otSec: 0,
    });
  }
});

test('split: every 2dp line multiplies out to its money, for every second of a week', () => {
  // Brute force over the OT range the stub lives in: the printed hours × rate
  // is the paid amount, always.
  for (let sec = 40 * 3600; sec <= 55 * 3600; sec += 7) {
    const two = splitTwoDpHoursWeek(sec);
    const printed = Number(two.otHours.toFixed(2));
    assert.equal(printed, two.otHours);
    assert.equal(
      phpHourlyPayFromSeconds(OT, two.otSec),
      Math.round(Math.round(printed * 100) * OT) / 100,
      `sec=${sec}`,
    );
  }
});

// ── Dispatch engine: computeProratedRowPay ──────────────────────────────────

test('Dispatch: a non-HSL week from 2026-09-27 pays 12.54h × ₱427.50 = ₱5,360.85', () => {
  const r = computeProratedRowPay(hubstaffRow(NEW_WEEK), new Map(), EMAIL, { reg: REG, ot: OT }, false);
  assert.ok(r);
  assert.equal(r.regularPayPHP, 11_400);
  assert.equal(r.otPayPHP, 5_360.85);
  // The seconds it reports are the priced ones, so the displayed hours match.
  assert.equal(Math.round((r.otSec / 3600) * 100) / 100, 12.54);
  assert.equal(r.otSec, 45_144);
  assert.equal(r.totalSec, TOTAL_SEC);
});

test('Dispatch: the Sep 20–26 week keeps its whole-seconds money (forward-only)', () => {
  const r = computeProratedRowPay(hubstaffRow(OLD_WEEK), new Map(), EMAIL, { reg: REG, ot: OT }, false);
  assert.ok(r);
  assert.equal(r.regularPayPHP, 11_400);
  assert.equal(r.otPayPHP, 5_358.71);
  assert.equal(r.otSec, 45_126);
});

test('Dispatch: a flat catalog override prices 2dp too', () => {
  const r = computeProratedRowPay(
    hubstaffRow(NEW_WEEK),
    new Map(),
    EMAIL,
    { reg: 1, ot: 1 },
    false,
    null,
    { reg: REG, ot: OT },
  );
  assert.ok(r);
  assert.equal(r.otPayPHP, 5_360.85);
});

test('Dispatch: HSL is untouched by the gate (sheet form stays the authority)', () => {
  const before = computeProratedRowPay(hubstaffRow(OLD_WEEK), new Map(), EMAIL, { reg: REG, ot: OT }, true);
  const after = computeProratedRowPay(hubstaffRow(NEW_WEEK), new Map(), EMAIL, { reg: REG, ot: OT }, true);
  assert.ok(before && after);
  assert.equal(after.regularPayPHP, before.regularPayPHP);
  assert.equal(after.otPayPHP, before.otPayPHP);
});

// ── Wizard engine: proratePayForMidPeriodChange (constant history ≠ cache) ──

function constantHistory(): RateHistoryByEmail {
  return new Map([
    [EMAIL, [{ email: EMAIL, regularRate: REG, otRate: OT, effectiveFrom: new Date(2026, 0, 1) }]],
  ]);
}

test('wizard override path: a constant history rate over a stale cache prices 2dp from 09-27', () => {
  const r = proratePayForMidPeriodChange({
    days: NEW_WEEK,
    isHsl: false,
    history: constantHistory(),
    histEmail: EMAIL,
    fallbackReg: 250, // stale cache — history wins
    fallbackOt: 375,
  });
  assert.ok(r);
  assert.equal(r.change, null);
  assert.equal(r.regularPay, 11_400);
  assert.equal(r.otPay, 5_360.85);
  assert.deepEqual(r.segments.ot, [{ ratePhp: OT, hours: 12.54, payPhp: 5_360.85 }]);
  assert.deepEqual(r.segments.regular, [{ ratePhp: REG, hours: 40, payPhp: 11_400 }]);
  assert.deepEqual(r.otRatesUsed, [OT]);
});

test('wizard override path: the same week before 09-27 keeps raw seconds', () => {
  const r = proratePayForMidPeriodChange({
    days: OLD_WEEK,
    isHsl: false,
    history: constantHistory(),
    histEmail: EMAIL,
    fallbackReg: 250,
    fallbackOt: 375,
  });
  assert.ok(r);
  assert.equal(r.otPay, 5_358.71);
});

test('wizard override path: history equal to the cache still defers to the caller', () => {
  const r = proratePayForMidPeriodChange({
    days: NEW_WEEK,
    isHsl: false,
    history: constantHistory(),
    histEmail: EMAIL,
    fallbackReg: REG,
    fallbackOt: OT,
  });
  assert.equal(r, null);
});

// ── Wizard calcResults: the single-rate path lives inside PayrollWizard.tsx ──
// It cannot be imported, so pin that it takes the SAME split under the SAME
// gate. A change to one engine without the other is how the centavos drift.

test('wizard calcResults prices non-HSL daily rows through the shared split', () => {
  const src = readFileSync(path.join(process.cwd(), 'src/components/PayrollWizard.tsx'), 'utf8');
  assert.match(
    src,
    /if \(paid && weekDays && !weekDays\.isHsl && pricesAtTwoDpHours\(weekDays\.days\[0\]\?\.date\)\) \{/,
  );
  assert.match(src, /const two = splitTwoDpHoursWeek\(paid\.totalSec\);/);
  assert.match(src, /regularSec = two\.regularSec;\s*otSec = two\.otSec;/);
});
