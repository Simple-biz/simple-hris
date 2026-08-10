import { test } from 'node:test';
import assert from 'node:assert/strict';

import { preferredProcessor } from './urgent-payout-details';

/**
 * The Urgent queue's rail pre-selection feeds a Send button that records a REAL
 * payment_dispatches row. It must therefore agree with how Payment Dispatch
 * would route the same person, and must refuse to guess.
 *
 * Regression pinned here: it used to read `preferred_processor` alone and
 * default to `'wise'` — a RETIRED processor — so anyone routed via
 * `bank_preferred` or the legacy rates sheet was preselected onto a rail they
 * had no account on, with no wallet email to pre-fill.
 */

const base = {
  work_email: 'a@b.com',
  bank_preferred: null,
  preferred_processor: null,
  preferred_bank_slot: null,
  bank_name: null,
  account_holder_name: null,
  account_number: null,
  routing_number: null,
  alt_bank_name: null,
  alt_account_holder_name: null,
  alt_account_number: null,
  alt_routing_number: null,
  hurupay_email: null,
  wepay_email: null,
  higlobe_email: null,
  higlobe_account_name: null,
  wise_email: null,
  wise_tag: null,
  phone_number: null,
  swift_code: null,
  full_address: null,
};

test('bank_preferred wins over the disbursement pick', () => {
  assert.equal(
    preferredProcessor({ ...base, bank_preferred: 'hurupay', preferred_processor: 'wires' }),
    'hurupay',
  );
});

test('disbursement pick is used when bank_preferred is unset', () => {
  assert.equal(preferredProcessor({ ...base, preferred_processor: 'wires' }), 'wires');
});

test('legacy rates-sheet cell routes when neither employee_ids field is set', () => {
  assert.equal(preferredProcessor({ ...base }, 'HuruPay'), 'hurupay');
  assert.equal(preferredProcessor({ ...base }, 'x1153'), 'wires');
});

test('an account-suffix code stored in bank_preferred maps to wires', () => {
  assert.equal(preferredProcessor({ ...base, bank_preferred: 'x1161' }), 'wires');
});

test('NO rail resolves to null — never a guessed default', () => {
  assert.equal(preferredProcessor({ ...base }), null);
  assert.equal(preferredProcessor(undefined), null);
  assert.equal(preferredProcessor({ ...base }, ''), null);
  // The specific regression: this used to return 'wise'.
  assert.notEqual(preferredProcessor({ ...base }), 'wise');
});

test('a person with only wire details on file still resolves via their pick', () => {
  assert.equal(
    preferredProcessor({ ...base, preferred_processor: 'wise', bank_name: 'BPI', account_number: '1' }),
    'wise',
  );
});
