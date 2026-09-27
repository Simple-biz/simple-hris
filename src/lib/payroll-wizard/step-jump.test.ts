import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planWizardJump, type WizardJumpInput } from './step-jump';

const NEW = 'report_2026-09-13_to_2026-09-19.csv';
const OLD = 'report_2026-09-06_to_2026-09-12.csv';

const base: WizardJumpInput = {
  requestedStep: 2,
  requestedFile: NEW,
  calcSourceFile: NEW,
  newestSourceFile: NEW,
  isSpectator: false,
  pabPayoutWeekActive: false,
  stepCount: 9,
};

test('a plain jump on the live cycle just moves the step', () => {
  assert.deepEqual(planWizardJump(base), { kind: 'go', step: 2, switchToFile: null });
});

test('refused while spectating another operator', () => {
  assert.deepEqual(planWizardJump({ ...base, isSpectator: true }), { kind: 'refused', reason: 'spectating' });
});

test('from a replay, a jump for the live cycle returns to the current period', () => {
  assert.deepEqual(planWizardJump({ ...base, calcSourceFile: OLD }), { kind: 'go', step: 2, switchToFile: NEW });
});

test('never switches INTO a replay, even when the request names an older file', () => {
  assert.deepEqual(planWizardJump({ ...base, requestedFile: OLD }), { kind: 'go', step: 2, switchToFile: null });
});

test('no file named, or the upload list not loaded → the cycle is left alone', () => {
  assert.deepEqual(planWizardJump({ ...base, requestedFile: null, calcSourceFile: OLD }), { kind: 'go', step: 2, switchToFile: null });
  assert.deepEqual(planWizardJump({ ...base, newestSourceFile: null, calcSourceFile: null }), { kind: 'go', step: 2, switchToFile: null });
});

test('PAB (4) outside the payout week lands on 5; inside it stays 4', () => {
  assert.deepEqual(planWizardJump({ ...base, requestedStep: 4 }), { kind: 'go', step: 5, switchToFile: null });
  assert.deepEqual(planWizardJump({ ...base, requestedStep: 4, pabPayoutWeekActive: true }), { kind: 'go', step: 4, switchToFile: null });
});

test('out-of-range or fractional steps are refused', () => {
  for (const requestedStep of [0, 10, -1, 2.5, Number.NaN]) {
    assert.deepEqual(planWizardJump({ ...base, requestedStep }), { kind: 'refused', reason: 'invalid-step' });
  }
});
