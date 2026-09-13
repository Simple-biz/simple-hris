import test from 'node:test';
import assert from 'node:assert/strict';
import { maskAccount } from './account-mask';

test('all but the last four are bullets', () => {
  assert.equal(maskAccount('001234567890'), '••••••••7890');
});

test('a short value reveals nothing', () => {
  assert.equal(maskAccount('1234'), '••••');
});

test('absent stays absent', () => {
  assert.equal(maskAccount(null), null);
});

/**
 * The account number is never reformatted, and neither is its mask: the bullets
 * count CHARACTERS, so the hidden string keeps the same length as the value it
 * hides. The rule this replaced stripped `-` and spaces before counting, which
 * printed a 12-character mask over a 14-character account.
 */
test('separators are counted, not stripped', () => {
  assert.equal(maskAccount('1234-5678-9012'), '••••••••••9012');
});

/**
 * The direction that matters: dropping the strip can only ever reveal LESS.
 * When a separator falls inside the last four characters, three digits survive
 * instead of four. If this ever starts revealing a fourth digit again, the rule
 * has been loosened.
 */
test('a separator inside the last four hides a digit rather than exposing one', () => {
  const masked = maskAccount('1234 5678 90');
  assert.equal(masked, '••••••••8 90');
  assert.equal((masked ?? '').replace(/[^0-9]/g, '').length, 3);
});

test('an empty string is empty, not a bullet', () => {
  assert.equal(maskAccount(''), '');
});

/**
 * Leading zeros are the reason the copy button hands over the stored string
 * verbatim; the mask must not eat them either. `0000` is four characters, so it
 * is fully hidden; `00007890` keeps its real length.
 */
test('leading zeros survive in the mask length', () => {
  assert.equal(maskAccount('0000'), '••••');
  assert.equal(maskAccount('00007890'), '••••7890');
});

/**
 * A SWIFT/BIC code runs the same rule — the card and the form both mask it, and
 * a second rule for "the short one" is how the two would disagree.
 */
test('a SWIFT code masks by the same rule', () => {
  assert.equal(maskAccount('BOPIPHMM'), '••••PHMM');
});
