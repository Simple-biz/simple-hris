import test from 'node:test';
import assert from 'node:assert/strict';
import { payoutRailView } from './payout-rail-view';
import { PROCESSOR_OPTIONS } from '@/lib/employee-payment-processors';

test('wires: a card, and no wallet fields', () => {
  assert.deepEqual(payoutRailView('wires', true), { showBankCard: true, showWalletFields: false });
  // The bank name on the paid slot is irrelevant once the rail is known — a
  // wires payee with nothing filled in still gets the card, empty, so they can
  // see WHERE the details are expected.
  assert.deepEqual(payoutRailView('wires', false), { showBankCard: true, showWalletFields: false });
});

/**
 * The row that is easy to get backwards. Wise payees are paid into their BANK
 * ACCOUNT, not to a Wise handle, so they carry the same field set as wires.
 */
test('wise: a card, and no wallet fields', () => {
  assert.deepEqual(payoutRailView('wise', true), { showBankCard: true, showWalletFields: false });
  assert.deepEqual(payoutRailView('wise', false), { showBankCard: true, showWalletFields: false });
});

test('jeeves: both — a card AND the phone number', () => {
  assert.deepEqual(payoutRailView('jeeves', true), { showBankCard: true, showWalletFields: true });
  assert.deepEqual(payoutRailView('jeeves', false), { showBankCard: true, showWalletFields: true });
});

/**
 * No card, and the wallet identity is NEVER folded away — it is the whole payout
 * record for these three, and hiding it leaves a panel with nothing but a button.
 */
test('the wallet rails: no card, wallet fields always', () => {
  for (const rail of ['hurupay', 'wepay', 'higlobe'] as const) {
    assert.deepEqual(
      payoutRailView(rail, true),
      { showBankCard: false, showWalletFields: true },
      `${rail} must not print a card even with a bank name on file`,
    );
    assert.deepEqual(payoutRailView(rail, false), { showBankCard: false, showWalletFields: true });
  }
});

/**
 * `hurupay` is the STORED id; "Kolan" is only the label. A gate keyed on the
 * rebranded spelling matches nothing and silently hides every Kolan payee's
 * wallet address.
 */
test('the Kolan rail is keyed on its stored id, not its label', () => {
  assert.equal(PROCESSOR_OPTIONS.some((p) => p.id === 'hurupay'), true);
  assert.equal(PROCESSOR_OPTIONS.some((p) => (p.id as string) === 'kolan'), false);
  assert.deepEqual(payoutRailView('hurupay', false), { showBankCard: false, showWalletFields: true });
});

/**
 * FAILS CLOSED. A null rail is both "the wallet payload never arrived" and "no
 * tier resolved", and the two are indistinguishable here, so neither may turn
 * into "no rail, therefore show everything". Nothing wallet-shaped is ever
 * invented; a card appears only when there is a real bank name to print.
 */
test('no rail: never invents wallet fields, and only cards a real bank name', () => {
  assert.deepEqual(payoutRailView(null, true), { showBankCard: true, showWalletFields: false });
  assert.deepEqual(payoutRailView(null, false), { showBankCard: false, showWalletFields: false });
});

/**
 * Every id in the catalog is decided one way or the other. A new processor added
 * to PROCESSOR_OPTIONS without a row in the table above would silently fall
 * through to "no card, no wallet fields" — a payee looking at an empty panel.
 */
test('every shipped processor id is answered explicitly', () => {
  const decided = new Set(['wires', 'wise', 'jeeves', 'hurupay', 'wepay', 'higlobe']);
  for (const p of PROCESSOR_OPTIONS) {
    assert.equal(decided.has(p.id), true, `${p.id} has no row in the rail table`);
    const view = payoutRailView(p.id, false);
    assert.equal(
      view.showBankCard || view.showWalletFields,
      true,
      `${p.id} would render an empty payout panel`,
    );
  }
});
