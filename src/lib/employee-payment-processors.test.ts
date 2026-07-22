import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isWiresPreferred,
  isBankPreferredTransitionAllowed,
} from './employee-payment-processors';

// WIRES is the residual: anything that isn't exactly hurupay/higlobe.
test('isWiresPreferred: hurupay and higlobe are NOT wires', () => {
  assert.equal(isWiresPreferred('hurupay'), false);
  assert.equal(isWiresPreferred('higlobe'), false);
});

test('isWiresPreferred: wires/x1153/legacy/null/empty all count as wires', () => {
  assert.equal(isWiresPreferred('wires'), true);
  assert.equal(isWiresPreferred('x1153'), true);
  assert.equal(isWiresPreferred('wise'), true);
  assert.equal(isWiresPreferred('jeeves'), true);
  assert.equal(isWiresPreferred('bpi'), true);
  assert.equal(isWiresPreferred(null), true);
  assert.equal(isWiresPreferred(undefined), true);
  assert.equal(isWiresPreferred(''), true);
});

// The ONLY forbidden transition: a WIRES employee → hurupay/higlobe.
test('transition: wires -> hurupay/higlobe is forbidden', () => {
  assert.equal(isBankPreferredTransitionAllowed('wires', 'hurupay'), false);
  assert.equal(isBankPreferredTransitionAllowed('wires', 'higlobe'), false);
});

test('transition: null/legacy (treated as wires) -> hurupay/higlobe is forbidden', () => {
  assert.equal(isBankPreferredTransitionAllowed(null, 'hurupay'), false);
  assert.equal(isBankPreferredTransitionAllowed(undefined, 'higlobe'), false);
  assert.equal(isBankPreferredTransitionAllowed('x1153', 'hurupay'), false);
});

test('transition: wires -> wires and null -> wires are allowed', () => {
  assert.equal(isBankPreferredTransitionAllowed('wires', 'wires'), true);
  assert.equal(isBankPreferredTransitionAllowed(null, 'wires'), true);
  assert.equal(isBankPreferredTransitionAllowed('x1153', 'wires'), true);
});

test('transition: hurupay/higlobe can move freely (incl. to wires)', () => {
  assert.equal(isBankPreferredTransitionAllowed('hurupay', 'higlobe'), true);
  assert.equal(isBankPreferredTransitionAllowed('higlobe', 'hurupay'), true);
  assert.equal(isBankPreferredTransitionAllowed('hurupay', 'wires'), true);
  assert.equal(isBankPreferredTransitionAllowed('higlobe', 'wires'), true);
  assert.equal(isBankPreferredTransitionAllowed('hurupay', 'hurupay'), true);
});
