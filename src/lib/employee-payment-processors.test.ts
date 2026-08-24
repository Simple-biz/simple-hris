import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isWiresPreferred,
  isBankPreferredTransitionAllowed,
  processorIdFromBankPreferredText,
  processorForBankPreferredLabel,
  bankPreferredLabelForProcessor,
  PROCESSOR_OPTIONS,
  BANK_PREFERRED_OPTIONS,
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

// The DB's legacy free-text values may be cased/padded — the defensive
// trim+lowercase is load-bearing for the guard's `current` side.
test('isWiresPreferred: case- and whitespace-insensitive on legacy free-text', () => {
  assert.equal(isWiresPreferred(' Hurupay '), false);
  assert.equal(isWiresPreferred('HIGLOBE'), false);
  assert.equal(isWiresPreferred(' Wires '), true);
  assert.equal(isBankPreferredTransitionAllowed(' HURUPAY ', 'higlobe'), true);
  assert.equal(isBankPreferredTransitionAllowed(' Wires ', 'hurupay'), false);
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

// ── Kolan rebrand (2026-08-24) ──────────────────────────────────────────────
// Hurupay renamed itself to Kolan. The STORED value stayed `hurupay` on purpose,
// so these pin the two things that would otherwise silently misroute money.

// A rates-sheet cell that says "Kolan" must resolve to the SAME rail. Without
// this the person resolves to no processor at all and Payment Dispatch drops
// them from the queue — they simply do not get paid, with no error anywhere.
test('kolan resolves to the hurupay rail (sheet cell after the rebrand)', () => {
  assert.equal(processorIdFromBankPreferredText('kolan'), 'hurupay');
  assert.equal(processorIdFromBankPreferredText('Kolan'), 'hurupay');
  assert.equal(processorIdFromBankPreferredText(' KOLAN '), 'hurupay');
  // …and every pre-rebrand spelling keeps resolving exactly as before.
  assert.equal(processorIdFromBankPreferredText('hurupay'), 'hurupay');
  assert.equal(processorIdFromBankPreferredText('huru'), 'hurupay');
  assert.equal(processorIdFromBankPreferredText('huropay'), 'hurupay');
});

// `kolan` is the wallet rail, not the WIRES residual. Reading it as WIRES would
// permanently lock a wallet payee out of their own rail via the transition guard.
test('isWiresPreferred: kolan is the hurupay wallet, NOT wires', () => {
  assert.equal(isWiresPreferred('kolan'), false);
  assert.equal(isWiresPreferred(' Kolan '), false);
  assert.equal(isWiresPreferred('KOLAN'), false);
});

test('transition: kolan behaves exactly as hurupay on both sides of the guard', () => {
  assert.equal(isBankPreferredTransitionAllowed('kolan', 'higlobe'), true);
  assert.equal(isBankPreferredTransitionAllowed('kolan', 'wires'), true);
  assert.equal(isBankPreferredTransitionAllowed('higlobe', 'kolan'), true);
  // The lock is NOT loosened: a wires payee still cannot be moved onto the
  // wallet, whichever name the wallet happens to be called by.
  assert.equal(isBankPreferredTransitionAllowed('wires', 'kolan'), false);
  assert.equal(isBankPreferredTransitionAllowed(null, 'kolan'), false);
  assert.equal(isBankPreferredTransitionAllowed('x1153', 'kolan'), false);
});

// Non-loosening proof: ONLY `kolan` joined the wallet set. Every other legacy
// free-text spelling stays WIRES exactly as bank-preferred-routing.md §4
// requires — including the typo aliases the TEXT normaliser separately accepts.
test('isWiresPreferred: nothing except kolan was widened', () => {
  assert.equal(isWiresPreferred('huru'), true);
  assert.equal(isWiresPreferred('huropay'), true);
  assert.equal(isWiresPreferred('higloble'), true);
  assert.equal(isWiresPreferred('wise'), true);
  assert.equal(isWiresPreferred('kolanx'), true);
  assert.equal(isWiresPreferred('ko lan'), true);
});

// The label moved; the id did not. That is the whole rebrand in one assertion.
test('registry: hurupay id keeps its value, label reads Kolan', () => {
  const opt = PROCESSOR_OPTIONS.find((p) => p.id === 'hurupay');
  assert.ok(opt, 'hurupay must remain a processor id');
  assert.equal(opt.label, 'Kolan');
  assert.equal(BANK_PREFERRED_OPTIONS.find((o) => o.id === 'hurupay')?.label, 'Kolan');
  // Label <-> id round trip stays closed after the rename.
  assert.equal(processorForBankPreferredLabel('Kolan'), 'hurupay');
  assert.equal(bankPreferredLabelForProcessor('hurupay'), 'Kolan');
});
