import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CURRENT_PAYOUT_BRAND, payoutBrandLabel } from './payout-brand';

test('new paperwork is stamped kolan', () => {
  assert.equal(CURRENT_PAYOUT_BRAND, 'kolan');
  assert.equal(payoutBrandLabel(CURRENT_PAYOUT_BRAND), 'Kolan');
});

// The whole point of the stamp: a record signed before 2026-08-24 keeps its
// original brand. Every row that existed at migration time is unstamped or
// explicitly 'hurupay', and both must print the old name.
test('pre-rebrand records still read Hurupay', () => {
  assert.equal(payoutBrandLabel('hurupay'), 'Hurupay');
  assert.equal(payoutBrandLabel(null), 'Hurupay');
  assert.equal(payoutBrandLabel(undefined), 'Hurupay');
  assert.equal(payoutBrandLabel(''), 'Hurupay');
});

test('stamp reading is case- and whitespace-insensitive', () => {
  assert.equal(payoutBrandLabel(' Kolan '), 'Kolan');
  assert.equal(payoutBrandLabel('KOLAN'), 'Kolan');
  assert.equal(payoutBrandLabel(' HURUPAY '), 'Hurupay');
});

// Fails toward the OLD name on purpose: an unreadable stamp must never retitle
// a historical document.
test('an unrecognised stamp falls back to Hurupay, never Kolan', () => {
  assert.equal(payoutBrandLabel('wise'), 'Hurupay');
  assert.equal(payoutBrandLabel('kolanx'), 'Hurupay');
  assert.equal(payoutBrandLabel('{}'), 'Hurupay');
});
