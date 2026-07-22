import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapBankOverrideToColumns } from './bank-override-mapping';

/**
 * The Mark Paid modal's profile override maps the four semantic recipient
 * fields back to employee_ids columns. `target` mirrors what the modal
 * displayed (resolveMarkPaidDefaults): 'bank' = wire details (wires / jeeves /
 * wise-routed-with-own-bank), 'wallet' = processor wallet. The SERVER owns the
 * slot decision (preferred_bank_slot) — primary vs alternative columns.
 */

test('bank target + primary slot writes the primary wire columns', () => {
  const r = mapBankOverrideToColumns({
    target: 'bank',
    processor: 'wires',
    preferredBankSlot: 'primary',
    values: {
      preferredBank: 'BPI',
      accountNumber: '0098-2231-7710',
      accountHolder: 'Juan Dela Cruz',
      swiftCode: 'BOPIPHMM',
    },
  });
  assert.deepEqual(r, {
    columns: {
      bank_name: 'BPI',
      account_holder_name: 'Juan Dela Cruz',
      account_number: '0098-2231-7710',
      swift_code: 'BOPIPHMM',
    },
  });
});

test('bank target + alternative slot writes the alt_* columns (swift → alt_routing_number)', () => {
  const r = mapBankOverrideToColumns({
    target: 'bank',
    processor: 'jeeves',
    preferredBankSlot: 'alternative',
    values: {
      preferredBank: 'UnionBank',
      accountNumber: '111-222-333',
      accountHolder: 'Maria Clara',
      swiftCode: 'UBPHPHMM',
    },
  });
  assert.deepEqual(r, {
    columns: {
      alt_bank_name: 'UnionBank',
      alt_account_holder_name: 'Maria Clara',
      alt_account_number: '111-222-333',
      alt_routing_number: 'UBPHPHMM',
    },
  });
});

test('bank target: blank optional fields clear to null, values are trimmed', () => {
  const r = mapBankOverrideToColumns({
    target: 'bank',
    processor: 'wires',
    preferredBankSlot: 'primary',
    values: {
      preferredBank: '  BDO  ',
      accountNumber: ' 555 ',
      accountHolder: '',
      swiftCode: '   ',
    },
  });
  assert.deepEqual(r, {
    columns: {
      bank_name: 'BDO',
      account_holder_name: null,
      account_number: '555',
      swift_code: null,
    },
  });
});

test('empty account number is an error regardless of target', () => {
  const r = mapBankOverrideToColumns({
    target: 'bank',
    processor: 'wires',
    preferredBankSlot: 'primary',
    values: { accountNumber: '   ' },
  });
  assert.deepEqual(r, { error: 'Account / wallet ID is required' });
});

test('wallet + hurupay writes only hurupay_email', () => {
  const r = mapBankOverrideToColumns({
    target: 'wallet',
    processor: 'hurupay',
    preferredBankSlot: 'primary',
    values: { preferredBank: 'Hurupay', accountNumber: 'person@mail.com', accountHolder: 'Ignored Co' },
  });
  assert.deepEqual(r, { columns: { hurupay_email: 'person@mail.com' } });
});

test('wallet + wepay writes only wepay_email', () => {
  const r = mapBankOverrideToColumns({
    target: 'wallet',
    processor: 'wepay',
    preferredBankSlot: 'primary',
    values: { accountNumber: 'w@mail.com' },
  });
  assert.deepEqual(r, { columns: { wepay_email: 'w@mail.com' } });
});

test('wallet + higlobe writes higlobe_email + higlobe_account_name', () => {
  const r = mapBankOverrideToColumns({
    target: 'wallet',
    processor: 'higlobe',
    preferredBankSlot: 'primary',
    values: { accountNumber: 'h@mail.com', accountHolder: 'Juan Dela Cruz' },
  });
  assert.deepEqual(r, {
    columns: { higlobe_email: 'h@mail.com', higlobe_account_name: 'Juan Dela Cruz' },
  });
});

test('wallet + wise writes wise_email + account_holder_name', () => {
  const r = mapBankOverrideToColumns({
    target: 'wallet',
    processor: 'wise',
    preferredBankSlot: 'primary',
    values: { accountNumber: 'wise@mail.com', accountHolder: 'Maria Clara' },
  });
  assert.deepEqual(r, {
    columns: { wise_email: 'wise@mail.com', account_holder_name: 'Maria Clara' },
  });
});

test('wallet target ignores the slot — hurupay maps identically on alternative', () => {
  const r = mapBankOverrideToColumns({
    target: 'wallet',
    processor: 'hurupay',
    preferredBankSlot: 'alternative',
    values: { accountNumber: 'person@mail.com' },
  });
  assert.deepEqual(r, { columns: { hurupay_email: 'person@mail.com' } });
});

test('wallet with a non-wallet processor is an error', () => {
  const r = mapBankOverrideToColumns({
    target: 'wallet',
    processor: 'wires',
    preferredBankSlot: 'primary',
    values: { accountNumber: '555' },
  });
  assert.deepEqual(r, { error: 'No wallet mapping for processor "wires"' });
});
