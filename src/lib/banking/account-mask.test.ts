import test from 'node:test';
import assert from 'node:assert/strict';
import { maskAccount } from './account-mask';

const BULLET = '•';

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
 * THE REGRESSION THIS FILE EXISTS FOR.
 *
 * A first cut of `maskAccount` used `value.length <= 4` as its floor, matching
 * the character-counted bullets. That is wrong: a value whose stripped length is
 * ≤ 4 but whose raw length is > 4 falls past the floor into the reveal branch,
 * and `" 1234"` then prints `"•1234"` — the entire value, from a function whose
 * only job is to hide it.
 *
 * The floor counts DIGITS; the bullets count CHARACTERS. Each row below is a
 * value the broken version leaked.
 */
test('a separator can never pad a short value past the floor', () => {
  for (const stored of [' 1234', '12-34', '1234 ', '1 2 3 4', '-1234', '1234-', '  12  34  ']) {
    const masked = maskAccount(stored);
    assert.equal(
      masked,
      BULLET.repeat(stored.length),
      `${JSON.stringify(stored)} carries only four characters and must be fully hidden`,
    );
    assert.equal(
      /[0-9A-Za-z]/.test(masked ?? ''),
      false,
      `${JSON.stringify(stored)} leaked a character through the mask`,
    );
  }
});

/**
 * The rule this replaced, reproduced verbatim from the deleted `maskSensitive`
 * in employee-payout-fields.tsx, so the safety property is PROVEN differentially
 * rather than asserted in a comment. It is the only reference point that
 * matters: the form has shipped this exposure for a long time, and the card must
 * not widen it.
 */
function previousRule(v: string): string {
  if (!v) return '';
  const clean = v.replace(/[-\s]/g, '');
  if (clean.length <= 4) return BULLET.repeat(clean.length);
  return BULLET.repeat(clean.length - 4) + clean.slice(-4);
}

/** The characters a mask actually discloses: everything that is not a bullet. */
function revealed(masked: string): string {
  return masked.split(BULLET).join('').replace(/[-\s]/g, '');
}

test('the new rule never discloses more than the rule it replaced', () => {
  const inputs = [
    '',
    '1',
    '1234',
    '0000',
    '00007890',
    '12345',
    '001234567890',
    '1234-5678-9012',
    '1234 5678 90',
    ' 1234',
    '12-34',
    '1234 ',
    '1 2 3 4',
    '-1234',
    '1234-',
    '  12  34  ',
    '123456789 ',
    ' 00 11 22 33 ',
    'BOPIPHMM',
    'BOPI-PHMM',
  ];

  for (const stored of inputs) {
    const before = revealed(previousRule(stored));
    const after = revealed(maskAccount(stored) ?? '');
    assert.ok(
      after.length <= before.length,
      `${JSON.stringify(stored)}: discloses ${after.length} characters, up from ${before.length}`,
    );
    assert.ok(
      before.endsWith(after),
      `${JSON.stringify(stored)}: discloses ${JSON.stringify(after)}, which is not a suffix of the previous ${JSON.stringify(before)}`,
    );
  }
});

/**
 * Within the reveal branch, a separator among the last four characters costs a
 * digit rather than exposing one. Narrower than the differential test above —
 * this one pins the mechanism, that one pins the guarantee.
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
 * verbatim; the mask must not eat them either. `0000` carries four characters,
 * so it is fully hidden; `00007890` keeps its real length.
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
