import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pickPreferredBank,
  readBankSlot,
  bankSlotHasAccount,
  sameBankAccount,
  paidBankSlot,
} from './preferred-bank';

/**
 * The payout DECK (Profile → Compensation → Payout, `BankCardDeck`) prints two
 * accounts at once. That is only honest while two rules hold, and both of them
 * are one careless edit from being false:
 *
 *   1. the FRONT card is still `pickPreferredBank` — the account Payment
 *      Dispatch pays, unchanged from before the deck existed; and
 *   2. the BACK card never borrows a field from the front one.
 *
 * `pickPreferredBank` exists to do exactly that borrowing (a half-filled record
 * still names the account PD pays), so reusing it for the backup would print two
 * cards claiming one bank — the invented equivalence people-bank-card.md §2
 * forbids, with the added twist that Accounting would then believe a fallback
 * destination exists.
 */

const TWO_SLOTS = {
  preferred_bank_slot: 'primary',
  bank_name: 'GoTyme Bank',
  account_holder_name: 'Ana Cruz',
  account_number: '001234567890',
  swift_code: 'GOTYPHM1',
  alt_bank_name: 'BDO Unibank',
  alt_account_holder_name: 'Ana S. Cruz',
  alt_account_number: '9988776655',
  alt_routing_number: 'BNORPHMM',
} as const;

test('the backup card never borrows a field from the paid slot', () => {
  // Only the alternative slot's bank NAME is filled. `pickPreferredBank` would
  // hand back the primary holder and the primary account number beside it.
  const backup = readBankSlot(
    { bank_name: 'GoTyme Bank', account_holder_name: 'Ana Cruz', account_number: '001234567890', alt_bank_name: 'BDO Unibank' },
    'alternative',
  );
  assert.equal(backup.name, 'BDO Unibank');
  assert.equal(backup.holder, null);
  assert.equal(backup.account, null);
  assert.equal(backup.swift, null);
  assert.equal(backup.isAlternativeSlot, true);
});

test('the alternative slot has no second wire column to fall to', () => {
  // There is no alt_swift_code. `alt_routing_number` IS the alternative slot's
  // wire code; the primary slot's swift_code belongs to the other card.
  const backup = readBankSlot({ swift_code: 'GOTYPHM1', alt_bank_name: 'BDO Unibank' }, 'alternative');
  assert.equal(backup.swift, null);
});

test('the primary slot keeps its OWN legacy wire chain, and only that', () => {
  // Rows entered before swift_code existed put the wire code in routing_number.
  // Both columns are the primary slot's, so the chain stays inside the slot.
  assert.equal(readBankSlot({ routing_number: 'PNBMPHMM' }, 'primary').swift, 'PNBMPHMM');
  assert.equal(
    readBankSlot({ swift_code: 'GOTYPHM1', routing_number: 'PNBMPHMM' }, 'primary').swift,
    'GOTYPHM1',
  );
  // …and never crosses into the alternative slot's, which pickPreferredBank does.
  assert.equal(readBankSlot({ alt_routing_number: 'BNORPHMM' }, 'primary').swift, null);
  assert.equal(pickPreferredBank({ alt_routing_number: 'BNORPHMM' }).swift, 'BNORPHMM');
});

test('the deck front stays byte-identical to the card that shipped without it', () => {
  // The gate below only lets the deck render when BOTH slots are filled — and in
  // that case pickPreferredBank never needs its fallback, so the front card is
  // the same object the pane printed before the deck existed.
  const paid = pickPreferredBank(TWO_SLOTS);
  const front = readBankSlot(TWO_SLOTS, paidBankSlot(TWO_SLOTS));
  assert.deepEqual(paid, front);
});

test('an alternative-slot payee puts the ALTERNATIVE card in front', () => {
  const row = { ...TWO_SLOTS, preferred_bank_slot: 'alternative' };
  assert.equal(paidBankSlot(row), 'alternative');
  const paid = pickPreferredBank(row);
  assert.equal(paid.account, '9988776655');
  assert.deepEqual(paid, readBankSlot(row, 'alternative'));
  // …and the primary becomes the backup behind it.
  assert.equal(readBankSlot(row, 'primary').account, '001234567890');
});

test('anything other than the literal alternative flag is the primary slot', () => {
  assert.equal(paidBankSlot(null), 'primary');
  assert.equal(paidBankSlot({}), 'primary');
  assert.equal(paidBankSlot({ preferred_bank_slot: null }), 'primary');
  assert.equal(paidBankSlot({ preferred_bank_slot: 'Alternative' }), 'primary');
});

test('one account spread across the record does NOT earn a second card', () => {
  // The classic shape: details live only in the primary columns while the stored
  // preference says alternative. pickPreferredBank falls back, so the paid card
  // and the raw other slot resolve to the SAME account — printing it twice would
  // tell Accounting a fallback destination exists when none does.
  const row = {
    preferred_bank_slot: 'alternative',
    bank_name: 'GoTyme Bank',
    account_number: '001234567890',
  };
  const paid = pickPreferredBank(row);
  const backup = readBankSlot(row, 'primary');
  assert.equal(sameBankAccount(paid, backup), true);
});

test('a blank alternative slot is not an account', () => {
  assert.equal(bankSlotHasAccount(readBankSlot({ alt_bank_name: '   ' }, 'alternative')), false);
  assert.equal(bankSlotHasAccount(readBankSlot({}, 'alternative')), false);
  // A bank name alone is enough to be worth showing: it is a real second
  // destination the employee has started recording, and the card says plainly
  // which fields are still missing.
  assert.equal(bankSlotHasAccount(readBankSlot({ alt_bank_name: 'BDO Unibank' }, 'alternative')), true);
  assert.equal(bankSlotHasAccount(readBankSlot({ alt_account_number: '9988776655' }, 'alternative')), true);
});

test('two accounts at the same bank are still two accounts', () => {
  const a = readBankSlot({ bank_name: 'BDO Unibank', account_number: '1111' }, 'primary');
  const b = readBankSlot({ alt_bank_name: 'BDO Unibank', alt_account_number: '2222' }, 'alternative');
  assert.equal(sameBankAccount(a, b), false);
});
