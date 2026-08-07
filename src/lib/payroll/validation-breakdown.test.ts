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
