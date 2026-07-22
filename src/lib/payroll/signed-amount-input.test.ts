import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSignedAmountInput, normalizeSignedAmountDisplay } from './signed-amount-input';

// ── The bug this guards against ─────────────────────────────────────────────
// The Payroll Wizard's Adjustment ("Adj.") inputs used `<input type="number">`
// with `raw === '' ? 0 : Number(raw)`. A lone "-" (the first keystroke of any
// negative adjustment) reads back as "" from a number input, so it was coerced
// to 0 and the negative could never be entered. parseSignedAmountInput models
// the mid-edit states as `incomplete` so the caller keeps the raw string and
// leaves the committed value alone until a real number is typed.

test('a lone minus sign is incomplete — do not clobber the model to 0', () => {
  const r = parseSignedAmountInput('-');
  assert.equal(r.incomplete, true);
  assert.equal(r.value, null);
});

test('a full negative amount parses to a negative number', () => {
  assert.deepEqual(parseSignedAmountInput('-500'), { value: -500, incomplete: false });
  assert.deepEqual(parseSignedAmountInput('-500.50'), { value: -500.5, incomplete: false });
});

test('a plain and explicitly-positive amount parse to the positive number', () => {
  assert.deepEqual(parseSignedAmountInput('500'), { value: 500, incomplete: false });
  assert.deepEqual(parseSignedAmountInput('+500'), { value: 500, incomplete: false });
});

test('empty string is a real committed clear, not a transient edit', () => {
  assert.deepEqual(parseSignedAmountInput(''), { value: null, incomplete: false });
  assert.deepEqual(parseSignedAmountInput('   '), { value: null, incomplete: false });
});

test('mid-edit fragments are incomplete (keep them on screen, do not commit)', () => {
  // A sign and/or a bare decimal point with NO digit yet: legal to keep on
  // screen, nothing to commit.
  for (const frag of ['-', '+', '.', '-.', '+.']) {
    const r = parseSignedAmountInput(frag);
    assert.equal(r.incomplete, true, `"${frag}" should be incomplete`);
    assert.equal(r.value, null, `"${frag}" should not commit a value`);
  }
});

test('a trailing decimal point is a valid in-progress number, committed at its integer value', () => {
  // "-5." — the user is about to type the cents. Commit -5 now; the trailing
  // dot stays in the field (display), so typing continues naturally.
  assert.deepEqual(parseSignedAmountInput('-5.'), { value: -5, incomplete: false });
  assert.deepEqual(parseSignedAmountInput('5.'), { value: 5, incomplete: false });
  // "-0." carries a digit, so it commits (to 0) — it is NOT a bare fragment.
  assert.deepEqual(parseSignedAmountInput('-0.'), { value: 0, incomplete: false });
});

test('thousands separators are tolerated (mirrors the board Adjustment parser)', () => {
  assert.deepEqual(parseSignedAmountInput('1,000'), { value: 1000, incomplete: false });
  assert.deepEqual(parseSignedAmountInput('-1,234.50'), { value: -1234.5, incomplete: false });
});

test('a leading currency marker is stripped defensively', () => {
  assert.deepEqual(parseSignedAmountInput('₱-500'), { value: -500, incomplete: false });
  assert.deepEqual(parseSignedAmountInput('-₱500'), { value: -500, incomplete: false });
  assert.deepEqual(parseSignedAmountInput('$250'), { value: 250, incomplete: false });
});

test('garbage is rejected as an invalid (not incomplete) entry', () => {
  for (const bad of ['abc', '--5', '5-', '5.5.5', '1e3', '+-5', '5 5']) {
    const r = parseSignedAmountInput(bad);
    assert.equal(r.incomplete, false, `"${bad}" should not be treated as mid-edit`);
    assert.equal(r.value, null, `"${bad}" should not commit a value`);
  }
});

test('zero and negative zero commit as 0', () => {
  assert.deepEqual(parseSignedAmountInput('0'), { value: 0, incomplete: false });
  assert.deepEqual(parseSignedAmountInput('-0'), { value: 0, incomplete: false });
});

test('rounds to cents so floating dust never reaches the money model', () => {
  const r = parseSignedAmountInput('-500.123');
  assert.equal(r.value, -500.12);
});

// ── normalizeSignedAmountDisplay: what to show when an external value arrives ─

test('normalizeSignedAmountDisplay renders numbers as plain signed decimals', () => {
  assert.equal(normalizeSignedAmountDisplay(-500), '-500');
  assert.equal(normalizeSignedAmountDisplay(500), '500');
  assert.equal(normalizeSignedAmountDisplay(-500.5), '-500.5');
  assert.equal(normalizeSignedAmountDisplay(0), '0');
});

test('normalizeSignedAmountDisplay renders null/undefined as an empty field', () => {
  assert.equal(normalizeSignedAmountDisplay(null), '');
  assert.equal(normalizeSignedAmountDisplay(undefined), '');
});
