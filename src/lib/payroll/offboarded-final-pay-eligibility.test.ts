import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isEligibleForFinalPayReview } from './offboarded-final-pay-eligibility';

test('temporary_pause is excluded — the person is expected back, not leaving', () => {
  assert.equal(isEligibleForFinalPayReview('temporary_pause'), false);
});

test('every real departure reason is eligible', () => {
  for (const reason of [
    'ncns',
    'resigned',
    'end_of_contract',
    'performance',
    'attendance',
    'time_manipulation',
    'other',
  ]) {
    assert.equal(isEligibleForFinalPayReview(reason), true);
  }
});

test('an unknown/undetermined reason (null) is eligible — fail toward showing, not hiding', () => {
  assert.equal(isEligibleForFinalPayReview(null), true);
});
