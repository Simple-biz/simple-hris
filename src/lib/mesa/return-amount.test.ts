import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_MESA_RETURN_PHP, checkReturnAmount } from './return-amount';

describe('checkReturnAmount', () => {
  test('a positive amount is accepted and rounded to centavos', () => {
    assert.deepEqual(checkReturnAmount(10), { ok: true, amount: 10 });
    assert.deepEqual(checkReturnAmount('500.5'), { ok: true, amount: 500.5 });
    assert.deepEqual(checkReturnAmount(0.105), { ok: true, amount: 0.11 });
  });

  test('missing, zero, negative and junk are refused', () => {
    for (const v of [null, undefined, '', '   ', 0, -1, '-5', 'abc', NaN, Infinity, 0.004]) {
      assert.equal(checkReturnAmount(v).ok, false, String(v));
    }
  });

  test('a boolean or object is not an amount (Number(true) is 1)', () => {
    assert.equal(checkReturnAmount(true).ok, false);
    assert.equal(checkReturnAmount({}).ok, false);
    assert.equal(checkReturnAmount([5]).ok, false);
  });

  test('the column ceiling is enforced', () => {
    assert.equal(checkReturnAmount(MAX_MESA_RETURN_PHP).ok, true);
    assert.equal(checkReturnAmount(MAX_MESA_RETURN_PHP + 1).ok, false);
  });

  test('NOT judged against the balance — a return is an inflow', () => {
    // There is no balance parameter at all; a large return is the Review modal's
    // flag to raise, not a refusal.
    assert.equal(checkReturnAmount.length, 1);
  });
});
