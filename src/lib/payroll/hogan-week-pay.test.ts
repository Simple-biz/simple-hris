import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  collapsedEquivalent,
  computeHoganWeekPay,
  HSL_WEEKEND_PREMIUM_PHP,
  OT_DIFFERENTIAL_MULTIPLIER,
} from './hogan-week-pay';

/**
 * Carla's mental model for this formula (the "Negan / Lucille" framing), which is what
 * makes the 0.5 rather than 1.5 intuitive:
 *
 *   Mon–Fri  — you swing at base damage. Exceeding quota still deals FULL damage,
 *              so every hour is already paid once at 1.0x.
 *   Sat/Sun  — same bat, premium upgrade: +₱15 extra damage per swing.
 *   Overtime — those hours already landed as a full-damage hit, so overtime is a
 *              0.5x "bleeding out bonus" applied ON TOP of damage already dealt.
 *
 * All figures below are synthetic or derived from published rate tiers — no real
 * employee data is committed here. The real-sheet oracle lives in
 * scripts/verify-hogan-formula.mts, which reads the export without committing it.
 */

test('the live worked example reconciles to the sheet exactly', () => {
  // Sheet row for week 7/26/26: M-F 36.40 @ 355, WE 8.10 @ 370, OT 4.50 @ 177.50.
  const p = computeHoganWeekPay({ mfHours: 36.4, weHours: 8.1, regularRatePhp: 355 });
  assert.equal(p.otHours, 4.5);
  assert.equal(p.weekendRatePhp, 370);
  assert.equal(p.otDifferentialPhp, 177.5);
  assert.equal(p.basePayPhp, 12922);
  assert.equal(p.weekendPayPhp, 2997);
  assert.equal(p.otDifferentialPayPhp, 798.75);
  assert.equal(p.totalHourlyPayPhp, 16717.75);
  // …and MESA (a separate sheet column, applied after this subtotal) nets the ₱16,617.75
  // that Accounting quoted.
  assert.equal(Math.round((p.totalHourlyPayPhp - 100) * 100) / 100, 16617.75);
});

test("Kane's 2026-08-11 rule statement: worked example pins", () => {
  // "43 × ₱235 = ₱10,105 · 2 × ₱250 = ₱500 · 5 × ₱117.50 = ₱587.50 → ₱11,192.50.
  //  The overtime adjustment is simply (hours_over_40) × (regular_rate × 0.5)."
  const a = computeHoganWeekPay({ mfHours: 43, weHours: 2, regularRatePhp: 235 });
  assert.equal(a.basePayPhp, 10105);
  assert.equal(a.weekendPayPhp, 500);
  assert.equal(a.otHours, 5);
  assert.equal(a.otDifferentialPayPhp, 587.5);
  assert.equal(a.totalHourlyPayPhp, 11192.5);

  // First example, in the corrected differential form: 35 M-F + 8 WE = 43 total.
  const b = computeHoganWeekPay({ mfHours: 35, weHours: 8, regularRatePhp: 235 });
  assert.equal(b.basePayPhp, 8225);
  assert.equal(b.weekendPayPhp, 2000);
  assert.equal(b.otDifferentialPayPhp, 352.5); // 3 × 117.50 — NOT 3 × 352.50
  assert.equal(b.totalHourlyPayPhp, 10577.5);
});

test('angelicaco 2026-08-02 week: past-cap weekend hours keep the +15 premium', () => {
  // Raw Hubstaff seconds → hours: Mon 8:59:46 + Tue 8:49:04 + Wed 8:02:59 +
  // Fri 8:31:03 = 34.381111h M-F; Sat 8:58:14 = 8.970556h WE. The cap crossed
  // mid-Saturday, and under this rule that changes NOTHING about the weekend
  // leg: all 8.97h price at ₱250. Sheet target ₱10,715.43 (+₱5,400 bonuses =
  // Kane's ₱16,115.43); the retired within-cap scoping produced ₱10,665.74.
  const p = computeHoganWeekPay({
    mfHours: 34.381111,
    weHours: 8.970556,
    regularRatePhp: 235,
  });
  assert.equal(p.mfHours, 34.38);
  assert.equal(p.weHours, 8.97);
  assert.equal(p.otHours, 3.35);
  assert.equal(p.basePayPhp, 8079.3);
  assert.equal(p.weekendPayPhp, 2242.5);
  assert.equal(p.otDifferentialPayPhp, 393.63);
  assert.equal(p.totalHourlyPayPhp, 10715.43);
});

test('weekend hours count toward the 40h overtime threshold', () => {
  // 31.95 M-F + 9.11 WE = 41.06 total -> 1.06 OT, even though M-F alone is under 40.
  // Confirmed on 1045/1045 real sheet rows carrying both weekend and OT hours.
  const p = computeHoganWeekPay({ mfHours: 31.95, weHours: 9.11, regularRatePhp: 300 });
  assert.equal(p.totalHours, 41.06);
  assert.equal(p.otHours, 1.06);
  assert.equal(p.hoursUntilOt, 0);
});

test('a weekend-heavy week still reaches overtime', () => {
  // 25.45 M-F + 17.34 WE = 42.79 -> 2.79 OT. M-F alone would give zero.
  const p = computeHoganWeekPay({ mfHours: 25.45, weHours: 17.34, regularRatePhp: 235 });
  assert.equal(p.otHours, 2.79);
});

test('under 40 total hours yields no overtime and reports hours remaining', () => {
  const p = computeHoganWeekPay({ mfHours: 32.05, weHours: 0, regularRatePhp: 225 });
  assert.equal(p.otHours, 0);
  assert.equal(p.hoursUntilOt, 7.95);
  assert.equal(p.otDifferentialPayPhp, 0);
  assert.equal(p.totalHourlyPayPhp, 7211.25); // 32.05 x 225
});

test('the weekend rate is always the regular rate plus the ₱15 premium', () => {
  for (const [rate, expected] of [[355, 370], [265, 280], [235, 250], [175, 190]] as const) {
    assert.equal(computeHoganWeekPay({ mfHours: 1, weHours: 1, regularRatePhp: rate }).weekendRatePhp, expected);
  }
  assert.equal(HSL_WEEKEND_PREMIUM_PHP, 15);
});

test('the OT differential is always half the regular rate', () => {
  for (const [rate, expected] of [[355, 177.5], [265, 132.5], [235, 117.5], [225, 112.5]] as const) {
    assert.equal(computeHoganWeekPay({ mfHours: 41, weHours: 0, regularRatePhp: rate }).otDifferentialPhp, expected);
  }
  assert.equal(OT_DIFFERENTIAL_MULTIPLIER, 0.5);
});

test('the differential is DERIVED, so an off-ratio stored OT rate cannot be expressed', () => {
  // The failure this design removes: 8 HSL people had `ot = reg + 15` stored (the
  // weekend premium mis-keyed into the OT column), underpaying every OT hour. Here the
  // differential comes from the regular rate, so 355 can only ever yield 177.50.
  const p = computeHoganWeekPay({ mfHours: 44.5, weHours: 0, regularRatePhp: 355 });
  assert.equal(p.otDifferentialPhp, 177.5);
  assert.notEqual(p.otDifferentialPhp, 355 + 15);
});

test('base pay covers ALL M-F hours including overtime — the hit already landed', () => {
  // 44.50 M-F hours: base pays all 44.50 at 1.0x, then 4.50 OT gets the 0.5x top-up.
  const p = computeHoganWeekPay({ mfHours: 44.5, weHours: 0, regularRatePhp: 355 });
  assert.equal(p.basePayPhp, Math.round(44.5 * 355 * 100) / 100);
  assert.equal(p.otHours, 4.5);
  assert.equal(p.otDifferentialPayPhp, Math.round(4.5 * 177.5 * 100) / 100);
});

test('two-stage and collapsed presentations agree to the centavo', () => {
  for (const c of [
    { mfHours: 36.4, weHours: 8.1, regularRatePhp: 355 },
    { mfHours: 44.5, weHours: 0, regularRatePhp: 355 },
    { mfHours: 31.95, weHours: 9.11, regularRatePhp: 300 },
    { mfHours: 25.45, weHours: 17.34, regularRatePhp: 235 },
    { mfHours: 20, weHours: 0, regularRatePhp: 265 },
  ]) {
    const p = computeHoganWeekPay(c);
    const collapsed = collapsedEquivalent(p);
    const twoStage = Math.round((p.basePayPhp + p.weekendPayPhp + p.otDifferentialPayPhp) * 100) / 100;
    assert.equal(
      collapsed.totalPhp,
      twoStage,
      `presentations diverged for ${JSON.stringify(c)}: ${collapsed.totalPhp} vs ${twoStage}`,
    );
  }
});

test('collapsed form reproduces the old paystub’s Regular/Overtime lines', () => {
  // The stub showed "Regular Hours 31.90 x 355" and "Overtime 4.50 x 532.50".
  const p = computeHoganWeekPay({ mfHours: 36.4, weHours: 8.1, regularRatePhp: 355 });
  const c = collapsedEquivalent(p);
  assert.equal(c.regularExclWeekendHours, 31.9);
  assert.equal(c.otRatePhp, 532.5);
  assert.equal(c.otHours, 4.5);
});

test('orphan pay is additive and does not affect hours or overtime', () => {
  const base = computeHoganWeekPay({ mfHours: 40, weHours: 0, regularRatePhp: 300 });
  const withOrphan = computeHoganWeekPay({ mfHours: 40, weHours: 0, regularRatePhp: 300, orphanPayPhp: 2152.09 });
  assert.equal(withOrphan.otHours, base.otHours);
  assert.equal(
    withOrphan.totalHourlyPayPhp,
    Math.round((base.totalHourlyPayPhp + 2152.09) * 100) / 100,
  );
});

// The sheet's AK/AL mid-week transition columns are deliberately NOT modeled here
// (ruling 2026-08-18): they exclude the pre-transition hours from the sheet's OT
// threshold, underpaying transition weeks against the documented HRIS rule that
// OT counts ALL hours worked. Mid-week rate changes price through
// priceChangedWeek2dp (prorate-mid-period.ts) — see its tests.

test('hours are rounded to 2dp before pricing, matching the sheet', () => {
  // The sheet stores 2dp hours and multiplies those; the old engine multiplied whole
  // seconds and diverged by ~₱1.14 per stub.
  const p = computeHoganWeekPay({ mfHours: 36.395278, weHours: 8.1025, regularRatePhp: 355 });
  assert.equal(p.mfHours, 36.4);
  assert.equal(p.weHours, 8.1);
  assert.equal(p.totalHourlyPayPhp, 16717.75);
});

test('a zero-hours week produces zeroes, not NaN', () => {
  const p = computeHoganWeekPay({ mfHours: 0, weHours: 0, regularRatePhp: 355 });
  assert.equal(p.totalHourlyPayPhp, 0);
  assert.equal(p.otHours, 0);
  assert.equal(p.hoursUntilOt, 40);
});

test('malformed hour inputs degrade to zero rather than poisoning the total', () => {
  for (const bad of [NaN, -5, Infinity, null, undefined]) {
    const p = computeHoganWeekPay({
      mfHours: bad as unknown as number,
      weHours: 8,
      regularRatePhp: 300,
    });
    assert.equal(p.mfHours, 0);
    assert.equal(Number.isFinite(p.totalHourlyPayPhp), true);
    assert.equal(p.totalHourlyPayPhp, Math.round(8 * 315 * 100) / 100);
  }
});

test('order of combining the two buckets does not matter (Carla’s "sandwich")', () => {
  // Carla: M-F hours group together, Sat/Sun group together; combine the two and any
  // EXCESS over 40 is overtime at half rate, "as the base hours have already been
  // compensated" — and the ORDER of combining does not matter.
  //
  // This holds because the ₱15 premium attaches to weekend HOURS regardless of whether
  // a given weekend hour lands in the regular or the overtime bucket, so the
  // chronological split cancels out entirely:
  //
  //   two-bucket : r·(MF+WE) + 15·WE + 0.5r·OT
  //   chronologic: r·REG + 1.5r·OT + 15·WE      (REG = min(total,40), OT = total-REG)
  //   and since MF+WE = REG+OT, both reduce to  r·REG + 1.5r·OT + 15·WE
  //
  // So swapping which bucket is "counted first" cannot move a peso.
  const rate = 355;
  for (const [mf, we] of [[36.4, 8.1], [8.1, 36.4], [40, 8], [8, 40], [20, 25], [25, 20]] as const) {
    const p = computeHoganWeekPay({ mfHours: mf, weHours: we, regularRatePhp: rate });
    // Excess is computed from the COMBINED total, so it is symmetric in the two inputs.
    assert.equal(p.otHours, Math.round(Math.max(0, mf + we - 40) * 100) / 100);
    // And the chronological form agrees, whichever bucket you imagine filling first.
    const chronological =
      Math.round(
        (Math.min(mf + we, 40) * rate + Math.max(0, mf + we - 40) * rate * 1.5 + we * 15) * 100,
      ) / 100;
    const twoBucket = Math.round((p.basePayPhp + p.weekendPayPhp + p.otDifferentialPayPhp) * 100) / 100;
    assert.ok(
      Math.abs(chronological - twoBucket) <= 0.02,
      `order mattered for mf=${mf} we=${we}: ${chronological} vs ${twoBucket}`,
    );
  }
});

test('swapping the buckets yields an identical total', () => {
  // The strongest form of the claim: the function is symmetric in (mfHours, weHours)
  // for the OVERTIME determination. Totals still differ because only weekend hours earn
  // the premium — that asymmetry is intended and is the ONLY asymmetry.
  const a = computeHoganWeekPay({ mfHours: 30, weHours: 14, regularRatePhp: 300 });
  const b = computeHoganWeekPay({ mfHours: 14, weHours: 30, regularRatePhp: 300 });
  assert.equal(a.otHours, b.otHours);
  assert.equal(a.totalHours, b.totalHours);
  assert.equal(a.otDifferentialPayPhp, b.otDifferentialPayPhp);
  // 16 more weekend hours in `b`, each carrying the ₱15 premium.
  assert.equal(
    Math.round((b.totalHourlyPayPhp - a.totalHourlyPayPhp) * 100) / 100,
    Math.round((30 - 14) * 15 * 100) / 100,
  );
});

test('exactly 40 hours is the boundary — no overtime, nothing remaining', () => {
  const p = computeHoganWeekPay({ mfHours: 40, weHours: 0, regularRatePhp: 355 });
  assert.equal(p.otHours, 0);
  assert.equal(p.hoursUntilOt, 0);
  const q = computeHoganWeekPay({ mfHours: 40, weHours: 0.01, regularRatePhp: 355 });
  assert.equal(q.otHours, 0.01);
});
