import test from 'node:test';
import assert from 'node:assert/strict';
import { pickPreferredBank } from './preferred-bank';

test('primary slot reads the primary columns', () => {
  const b = pickPreferredBank({
    preferred_bank_slot: 'primary',
    bank_name: 'GoTyme Bank', account_holder_name: 'Ana Cruz',
    account_number: '001234567890', swift_code: 'GOTYPHM1',
  });
  assert.equal(b.name, 'GoTyme Bank');
  assert.equal(b.account, '001234567890');
  assert.equal(b.swift, 'GOTYPHM1');
  assert.equal(b.isAlternativeSlot, false);
});

test('alternative slot reads the alt columns — INCLUDING its SWIFT', () => {
  // There is no alt_swift_code column. The employee form writes alt-slot SWIFT
  // into alt_routing_number (EmployeeProfile.tsx savePaymentDetails), so that is
  // where the alternative slot's wire code lives. Reading swift_code here would
  // print the PRIMARY account's code beside the ALTERNATIVE account's number,
  // and the copy button would hand over a wrong wire code.
  const b = pickPreferredBank({
    preferred_bank_slot: 'alternative',
    bank_name: 'BDO Unibank', swift_code: 'BNORPHMM',
    alt_bank_name: 'Maya Bank', alt_account_number: '9988776655',
    alt_routing_number: 'PAPHPHM1',
  });
  assert.equal(b.name, 'Maya Bank');
  assert.equal(b.account, '9988776655');
  assert.equal(b.swift, 'PAPHPHM1');
  assert.equal(b.isAlternativeSlot, true);
});

test('a preferred slot with empty fields falls back to the other slot, per field', () => {
  const b = pickPreferredBank({
    preferred_bank_slot: 'alternative',
    bank_name: 'BDO Unibank', account_number: '111122223333',
    alt_bank_name: '   ',
  });
  assert.equal(b.name, 'BDO Unibank');
  assert.equal(b.account, '111122223333');
  assert.equal(b.isAlternativeSlot, true);
});

test('an empty row yields nulls, never empty strings', () => {
  const b = pickPreferredBank({});
  assert.equal(b.name, null);
  assert.equal(b.account, null);
  assert.equal(b.swift, null);
  assert.equal(pickPreferredBank(null).name, null);
});
