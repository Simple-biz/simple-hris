import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { buildValidationBreakdown, type BreakdownInput } from './validation-breakdown';

/**
 * All figures synthetic. The real-sheet oracle is scripts/verify-hogan-formula.mts,
 * which reads an export that is deliberately never committed (real names + salaries).
 */
function baseInput(over: Partial<BreakdownInput> = {}): BreakdownInput {
  return {
    email: 'test@simple.biz',
    name: 'Test Person',
    deptKey: 'support',
    deptName: 'Support',
    isHsl: false,
    excluded: false,
    totalHours: 42,
    regularHours: 40,
    otHours: 2,
    regularRate: 200,
    otRate: 300,
    regularPay: 8000,
    otPay: 600,
    initialPay: 8600,
    weekend: null,
    rateChange: null,
    dispatch: {
      final: 9500,
      pab: 0, tech: 0, other: 1000, adjustment: 0,
      mesaDeduction: 100, mesaDisbursement: 0, orphanage: 0,
    },
    rateSourceIssue: null,
    ...over,
  };
}

test('base department: hours, rates and earnings come straight from the engine', () => {
  const b = buildValidationBreakdown(baseInput());
  assert.equal(b.hours.mf, 42);
  assert.equal(b.hours.we, 0);
  assert.equal(b.hours.ot, 2);
  assert.equal(b.rates?.mf, 200);
  assert.equal(b.rates?.ot, 300);
  assert.equal(b.rates?.we, null);
  assert.equal(b.rates?.otDifferential, null);
  assert.equal(b.earnings.base, 8000);
  assert.equal(b.earnings.weekend, 0);
  assert.equal(b.earnings.otPay, 600);
});

test('base department: gross sums components and ties to the dispatch total', () => {
  const b = buildValidationBreakdown(baseInput());
  // 8000 + 0 + 600 + 1000 bonus - 100 MESA = 9500
  assert.equal(b.gross, 9500);
  assert.equal(b.dispatchNet, 9500);
  assert.equal(b.flags.length, 0);
});

test('bonusParts itemise the dispatch payload', () => {
  const b = buildValidationBreakdown(baseInput({
    dispatch: {
      final: 11000, pab: 1000, tech: 500, other: 1000, adjustment: 0,
      mesaDeduction: 100, mesaDisbursement: 0, orphanage: 0,
    },
  }));
  assert.equal(b.earnings.bonuses, 2500);
  assert.deepEqual(b.earnings.bonusParts, { kpi: 1000, pab: 1000, tech: 500, other: 0 });
});

function hslInput(over: Partial<BreakdownInput> = {}): BreakdownInput {
  // Marie: M-F 38.00 @ ₱265, weekend 6.00 @ ₱280, so 44.00 total → 4.00 OT @ ₱132.50.
  //   base 38.00 × 265.00 = 10,070.00
  //   wknd  6.00 × 280.00 =  1,680.00
  //   OT ½  4.00 × 132.50 =    530.00   → 12,280.00
  //   + 500 adjustment + 250 orphanage - 100 MESA = 12,930.00
  return {
    email: 'marie@hogansmith.com',
    name: 'Marie C',
    deptKey: 'hsl',
    deptName: 'Hogan Smith Law',
    isHsl: true,
    excluded: false,
    totalHours: 44,
    regularHours: 40,
    otHours: 4,
    regularRate: 265,
    otRate: 397.5,
    regularPay: 11220,
    otPay: 1590,
    initialPay: 12810,
    weekend: { regularHours: 6, otHours: 0, regularPay: 1680, otPay: 0 },
    rateChange: null,
    dispatch: {
      final: 12930, pab: 0, tech: 0, other: 0, adjustment: 500,
      mesaDeduction: 100, mesaDisbursement: 0, orphanage: 250,
    },
    rateSourceIssue: null,
    ...over,
  };
}

test('HSL derives the weekend rate and OT differential from the M-F rate', () => {
  const b = buildValidationBreakdown(hslInput());
  assert.equal(b.rates?.mf, 265);
  assert.equal(b.rates?.we, 280);              // 265 + 15
  assert.equal(b.rates?.otDifferential, 132.5); // 265 × 0.5
});

test('HSL splits M-F from weekend and counts OT across all seven days', () => {
  const b = buildValidationBreakdown(hslInput());
  assert.equal(b.hours.we, 6);
  assert.equal(b.hours.mf, 38);   // 44 total - 6 weekend; INCLUDES its own OT hours
  assert.equal(b.hours.ot, 4);    // max(0, 44 - 40)
});

test('HSL gross reconciles to the sheet formula and to dispatch', () => {
  const b = buildValidationBreakdown(hslInput());
  assert.equal(b.earnings.base, 10070);
  assert.equal(b.earnings.weekend, 1680);
  assert.equal(b.earnings.otPay, 530);
  assert.equal(b.gross, 12930);
  assert.equal(b.dispatchNet, 12930);
});

test('the weekend carve-out is never added on top of regular pay', () => {
  // regularPay 11,220 already CONTAINS the 1,680 of weekend pay. A naive
  // base + weekend would report 12,900 of hourly pay instead of 12,280.
  const b = buildValidationBreakdown(hslInput());
  const hourly = b.earnings.base + b.earnings.weekend + b.earnings.otPay;
  assert.equal(hourly, 12280);
  assert.notEqual(hourly, 12900);
});

test('an HSL row with no per-day data degrades to the base shape', () => {
  const b = buildValidationBreakdown(hslInput({ weekend: null }));
  assert.equal(b.hours.we, 0);
  assert.equal(b.rates?.we, null);
  assert.equal(b.earnings.base, 11220);  // the engine's own regularPay
  assert.equal(b.earnings.weekend, 0);
  assert.equal(b.earnings.otPay, 1590);  // the engine's own otPay
});

function codes(b: { flags: { code: string }[] }): string[] {
  return b.flags.map((f) => f.code).sort();
}

test('no_rate: hours logged but no rate resolved', () => {
  const b = buildValidationBreakdown(baseInput({
    regularRate: null, otRate: null, regularPay: null, otPay: null, initialPay: null,
    dispatch: { final: 0, pab: 0, tech: 0, other: 0, adjustment: 0,
                mesaDeduction: 0, mesaDisbursement: 0, orphanage: 0 },
  }));
  assert.ok(codes(b).includes('no_rate'));
  assert.equal(b.flags.find((f) => f.code === 'no_rate')?.severity, 'red');
});

test('hours_without_pay: hours worked, nothing computed', () => {
  const b = buildValidationBreakdown(baseInput({
    regularPay: 0, otPay: 0, initialPay: 0,
    dispatch: { final: 0, pab: 0, tech: 0, other: 0, adjustment: 0,
                mesaDeduction: 0, mesaDisbursement: 0, orphanage: 0 },
  }));
  assert.ok(codes(b).includes('hours_without_pay'));
});

test('pay_without_hours: money with no hours behind it', () => {
  const b = buildValidationBreakdown(baseInput({
    totalHours: 0, regularHours: 0, otHours: 0,
    regularPay: 0, otPay: 0, initialPay: 0,
    dispatch: { final: 1000, pab: 0, tech: 0, other: 1000, adjustment: 0,
                mesaDeduction: 0, mesaDisbursement: 0, orphanage: 0 },
  }));
  assert.ok(codes(b).includes('pay_without_hours'));
});

test('negative_gross: an adjustment larger than the earnings', () => {
  const b = buildValidationBreakdown(baseInput({
    dispatch: { final: -1900, pab: 0, tech: 0, other: 0, adjustment: -10500,
                mesaDeduction: 0, mesaDisbursement: 0, orphanage: 0 },
  }));
  assert.ok(codes(b).includes('negative_gross'));
});

test('gross_mismatch: the parts do not sum to the stated total', () => {
  // Reproduces the live bug: a MESA disbursement present in the engine total but
  // missing from the itemisation the table renders.
  const b = buildValidationBreakdown(baseInput({
    dispatch: { final: 12000, pab: 0, tech: 0, other: 1000, adjustment: 0,
                mesaDeduction: 100, mesaDisbursement: 0, orphanage: 0 },
  }));
  assert.equal(b.gross, 9500);
  assert.equal(b.dispatchNet, 12000);
  assert.ok(codes(b).includes('gross_mismatch'));
});

test('gross_mismatch tolerates a centavo of rounding', () => {
  const b = buildValidationBreakdown(baseInput({
    dispatch: { final: 9500.01, pab: 0, tech: 0, other: 1000, adjustment: 0,
                mesaDeduction: 100, mesaDisbursement: 0, orphanage: 0 },
  }));
  assert.ok(!codes(b).includes('gross_mismatch'));
});

test('not_dispatchable: the row will never become a payment', () => {
  const b = buildValidationBreakdown(baseInput({ dispatch: null }));
  assert.equal(b.dispatchNet, null);
  assert.ok(codes(b).includes('not_dispatchable'));
  // gross_mismatch must NOT also fire — there is no total to disagree with.
  assert.ok(!codes(b).includes('gross_mismatch'));
});

test('a prorated week does not trip gross_mismatch', () => {
  const b = buildValidationBreakdown(baseInput({
    rateChange: { from: 285, to: 305 },
  }));
  assert.ok(!codes(b).includes('gross_mismatch'));
  assert.deepEqual(b.rateChange, { from: 285, to: 305 });
});

test('a clean row carries no flags', () => {
  assert.deepEqual(buildValidationBreakdown(baseInput()).flags, []);
});

test('ot_ratio: the stored OT rate is not 1.5x the regular rate', () => {
  // The reg+15 corruption: 265 + 15 = 280 sitting in the OT column, where
  // 265 × 1.5 = 397.50 belongs. Underpays ₱117.50 on every overtime hour.
  const b = buildValidationBreakdown(hslInput({ otRate: 280 }));
  assert.ok(codes(b).includes('ot_ratio'));
  assert.equal(b.flags.find((f) => f.code === 'ot_ratio')?.severity, 'amber');
});

test('ot_ratio does not fire when the ratio holds', () => {
  assert.ok(!codes(buildValidationBreakdown(hslInput())).includes('ot_ratio'));
});

test('ot_ratio is HSL-only', () => {
  // A base department's OT rate is a free-standing stored value, not a derived
  // differential — 300 against a 200 regular is 1.5x anyway, but 250 would not be
  // a defect there the way it is for HSL.
  const b = buildValidationBreakdown(baseInput({ otRate: 250 }));
  assert.ok(!codes(b).includes('ot_ratio'));
});

test('rate_source: paid rate differs from the sheet rate', () => {
  const b = buildValidationBreakdown(baseInput({
    rateSourceIssue: { shortfallPhp: 830, sheetRate: 305, paidRate: 285 },
  }));
  const f = b.flags.find((x) => x.code === 'rate_source');
  assert.equal(f?.severity, 'amber');
  assert.match(f?.message ?? '', /285/);
  assert.match(f?.message ?? '', /305/);
});

test('ot_ratio tolerates the centavo gap between the two rounding conventions', () => {
  // regularRate 2.71: two-step (mf×0.5 rounded, then +mf rounded) gives 4.07;
  // single-step (mf×1.5 rounded) gives 4.06. Both are legitimate 1.5x rates —
  // this must not flag as a corrupted ratio.
  const b = buildValidationBreakdown(hslInput({ regularRate: 2.71, otRate: 4.06 }));
  assert.ok(!codes(b).includes('ot_ratio'));
});

test('amber flags never suppress red ones', () => {
  const b = buildValidationBreakdown(hslInput({
    otRate: 280,
    dispatch: null,
  }));
  assert.ok(codes(b).includes('ot_ratio'));
  assert.ok(codes(b).includes('not_dispatchable'));
});
