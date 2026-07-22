import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveMarkPaidDefaults } from './mark-paid-defaults';

/**
 * The Mark as Paid modal's recipient section shows the employee's RECEIVING
 * details. Routing (which processor tab the person sits in) is a separate
 * decision driven by Bank Preferred. When Bank Preferred routes someone through
 * a wallet processor (e.g. Wise) but the employee's dashboard payout info is
 * their own bank (wire) details, the modal must surface the BANK details — the
 * receiving end follows the Employee Dashboard, not the routing processor.
 */

test('wise-routed employee with wire bank details shows the bank details, not the wise email', () => {
  const d = resolveMarkPaidDefaults({
    processor: 'wise',
    name: 'Fallback Name',
    details: {
      wise_email: 'someone@wise.com',
      bank_name: 'BPI',
      account_holder_name: 'Juan Dela Cruz',
      account_number: '0098-2231-7710',
      swift_code: 'BOPIPHMM',
    },
  });

  assert.equal(d.preferredBank, 'BPI');
  assert.equal(d.accountHolder, 'Juan Dela Cruz');
  assert.equal(d.accountNumber, '0098-2231-7710');
  assert.equal(d.swiftCode, 'BOPIPHMM');
  // SWIFT field must be revealed even though the processor is 'wise'.
  assert.equal(d.showSwiftField, true);
});

test('wise-routed employee WITHOUT bank details falls back to the wise wallet id', () => {
  const d = resolveMarkPaidDefaults({
    processor: 'wise',
    name: 'Fallback Name',
    details: {
      wise_email: 'someone@wise.com',
    },
  });

  assert.equal(d.preferredBank, 'Wise');
  assert.equal(d.accountNumber, 'someone@wise.com');
  assert.equal(d.accountHolder, 'Fallback Name');
  assert.equal(d.swiftCode, '');
  assert.equal(d.showSwiftField, false);
});

test('wise-routed employee with only a wise tag falls back to the tag', () => {
  const d = resolveMarkPaidDefaults({
    processor: 'wise',
    name: 'Tag Only',
    details: {
      wise_tag: '@tagonly',
      account_holder_name: 'Tag Only Holder',
    },
  });

  assert.equal(d.preferredBank, 'Wise');
  assert.equal(d.accountNumber, '@tagonly');
  // With no bank_name/account_number, this is a real Wise wallet — holder still
  // resolves from the details, SWIFT field stays hidden.
  assert.equal(d.showSwiftField, false);
});

test('genuine wires employee still resolves bank details and shows SWIFT', () => {
  const d = resolveMarkPaidDefaults({
    processor: 'wires',
    name: 'Wire Person',
    bankPreferredRaw: 'x1153',
    details: {
      bank_name: 'UnionBank',
      account_holder_name: 'Wire Person',
      account_number: '1122334455',
      swift_code: 'UBPHPHMM',
    },
  });

  assert.equal(d.preferredBank, 'UnionBank');
  assert.equal(d.accountNumber, '1122334455');
  assert.equal(d.swiftCode, 'UBPHPHMM');
  assert.equal(d.showSwiftField, true);
});

test('wires employee with no bank_name falls back to the raw bank-preferred label', () => {
  const d = resolveMarkPaidDefaults({
    processor: 'wires',
    name: 'Wire Person',
    bankPreferredRaw: 'x1153',
    details: {
      account_number: '1122334455',
    },
  });

  assert.equal(d.preferredBank, 'x1153');
  assert.equal(d.showSwiftField, true);
});

test('hurupay wallet employee is unaffected — email id, no bank, no SWIFT', () => {
  const d = resolveMarkPaidDefaults({
    processor: 'hurupay',
    name: 'Huru Person',
    details: {
      hurupay_email: 'huru@example.com',
      // A stray bank_name on a wallet-routed person must NOT hijack a
      // non-bank processor's defaults.
      bank_name: 'Some Bank',
    },
  });

  assert.equal(d.preferredBank, 'Hurupay');
  assert.equal(d.accountNumber, 'huru@example.com');
  assert.equal(d.showSwiftField, false);
});
