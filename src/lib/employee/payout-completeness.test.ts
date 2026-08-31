import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isPayoutComplete,
  resolveEffectivePayoutProcessor,
} from './payout-completeness';
import {
  isWalletRailLocked,
  isBankPreferredAllowedForReceiving,
} from '../employee-payment-processors';

/**
 * These pin the SHARED "how would Payment Dispatch route/pay this person"
 * resolution that the People tab (roster chip, Missing-bank list, profile
 * Banking view), the employee portal nudge, and Payroll Readiness all lean on.
 * Each case mirrors a real drift class found in the 2026-08-10 People-vs-PD
 * audit (~12% of the routed roster displayed wrong in People before the fix).
 */

test('bank_preferred wins over the Disbursement pick and the legacy cell', () => {
  const row = { bank_preferred: 'wires', preferred_processor: 'hurupay' };
  assert.equal(
    resolveEffectivePayoutProcessor(row, { bankPreferredRaw: 'Higlobe' }),
    'wires',
  );
});

test('Disbursement pick used when bank_preferred is unset', () => {
  const row = { bank_preferred: null, preferred_processor: 'higlobe' };
  assert.equal(resolveEffectivePayoutProcessor(row, { bankPreferredRaw: 'HuruPay' }), 'higlobe');
});

test('legacy rates cell routes when neither employee_ids pick is set (the 133-person class)', () => {
  const row = { bank_preferred: null, preferred_processor: null };
  assert.equal(resolveEffectivePayoutProcessor(row, { bankPreferredRaw: 'HuruPay ' }), 'hurupay');
  assert.equal(resolveEffectivePayoutProcessor(row, { bankPreferredRaw: 'x1161' }), 'wires');
  assert.equal(resolveEffectivePayoutProcessor(row, { bankPreferredRaw: 'transferwise' }), 'wise');
});

test('no row at all still resolves from the legacy cell (sheet-only people)', () => {
  assert.equal(resolveEffectivePayoutProcessor(null, { bankPreferredRaw: 'wires' }), 'wires');
  assert.equal(resolveEffectivePayoutProcessor(null, undefined), null);
});

test('sheet-routed hurupay person with a sheet-side wallet email is payable (the 27-person class)', () => {
  const row = { bank_preferred: null, preferred_processor: null, hurupay_email: null };
  assert.equal(
    isPayoutComplete(row, { bankPreferredRaw: 'Hurupay', hurupayEmail: 'x@y.com' }),
    true,
  );
  // …but without the extras (the People tab's old call shape) they were
  // wrongly "Missing bank info".
  assert.equal(isPayoutComplete(row, undefined), false);
});

test('higlobe needs BOTH email and account name; sheet fallbacks fill either', () => {
  const row = { bank_preferred: 'higlobe', higlobe_email: 'a@b.com', higlobe_account_name: null };
  assert.equal(isPayoutComplete(row, undefined), false);
  assert.equal(isPayoutComplete(row, { higlobeAccountName: 'A B' }), true);
});

test('wires is payable from EITHER bank slot (the hidden-account class)', () => {
  const row = {
    bank_preferred: 'wires',
    preferred_bank_slot: 'primary',
    bank_name: null,
    account_number: null,
    alt_bank_name: 'BPI',
    alt_account_number: '123',
  };
  assert.equal(isPayoutComplete(row, undefined), true);
});

test('wise needs full wire details — a Wise handle alone is not payable', () => {
  const row = { bank_preferred: 'wise', wise_email: 'w@x.com' };
  assert.equal(isPayoutComplete(row, undefined), false);
  assert.equal(
    isPayoutComplete({ ...row, bank_name: 'BDO', account_number: '99' }, undefined),
    true,
  );
});

test('unrouted person is never payable regardless of stored details', () => {
  const row = { bank_name: 'BDO', account_number: '99' };
  assert.equal(isPayoutComplete(row, undefined), false);
});

// ── Kolan rebrand (2026-08-24) ──────────────────────────────────────────────
// The legacy 'HuruPay' fixtures above are kept on purpose: the rates sheet is
// full of pre-rebrand spellings and they must keep resolving. These ADD the new
// spelling rather than replacing them.
test('a rebranded "Kolan" sheet cell routes to the hurupay rail', () => {
  const row = {};
  assert.equal(resolveEffectivePayoutProcessor(row, { bankPreferredRaw: 'Kolan' }), 'hurupay');
  assert.equal(resolveEffectivePayoutProcessor(row, { bankPreferredRaw: 'kolan ' }), 'hurupay');
});

// The failure this guards: an unresolved rail is not "defaults to wires", it is
// NULL — and Payment Dispatch excludes unrouted people from the queue outright,
// so the person silently goes unpaid.
test('"Kolan" never resolves to null (an unrouted person is never queued)', () => {
  assert.notEqual(resolveEffectivePayoutProcessor({ bank_preferred: 'Kolan' }, undefined), null);
  assert.equal(resolveEffectivePayoutProcessor({ bank_preferred: 'Kolan' }, undefined), 'hurupay');
});

// ── Wallet-rail lock, judged on the EFFECTIVE rail (2026-08-24) ─────────────
// The lock must read all three routing tiers, not just employee_ids
// .bank_preferred. ~1,351 people were seeded into the legacy rates cell in
// 2026-07-22 with preferred_processor deliberately cleared for 466 of them, so
// a large population is EXPLICITLY on wires while tier 1 is still NULL. A
// tier-1-only lock reads them as "never assigned" and would let a wire-only
// payee onto a wallet they cannot receive into.
test('lock: a legacy sheet-routed wires payee is LOCKED even with bank_preferred null', () => {
  const row = { bank_preferred: null, preferred_processor: null };
  const effective = resolveEffectivePayoutProcessor(row, { bankPreferredRaw: 'x1153' });
  assert.equal(effective, 'wires');
  assert.equal(isWalletRailLocked(effective), true);
});

test('lock: a wires DISBURSEMENT pick locks too, with bank_preferred null', () => {
  const row = { bank_preferred: null, preferred_processor: 'wires' };
  assert.equal(isWalletRailLocked(resolveEffectivePayoutProcessor(row, undefined)), true);
});

// The converse the old tier-1-only predicate also got wrong: someone already
// being paid on a wallet via the sheet read as locked out of their own rail.
test('lock: a legacy sheet-routed KOLAN payee is NOT locked', () => {
  const row = { bank_preferred: null, preferred_processor: null };
  assert.equal(
    isWalletRailLocked(resolveEffectivePayoutProcessor(row, { bankPreferredRaw: 'Kolan' })),
    false,
  );
});

// Only a person with NO rail anywhere is assignable — that is the narrow case
// Kane's ruling opened.
test('lock: only a person unrouted in ALL THREE tiers is assignable', () => {
  const row = { bank_preferred: null, preferred_processor: null };
  const effective = resolveEffectivePayoutProcessor(row, { bankPreferredRaw: null });
  assert.equal(effective, null, 'no tier resolves anything');
  assert.equal(isWalletRailLocked(effective), false);
  // Under the 1:1 rule (2026-08-31 PM) the write-time verdict keys on the
  // RECEIVING channel: unset receiving takes any assignment.
  assert.equal(isBankPreferredAllowedForReceiving(row.preferred_processor, 'kolan'), true);
});

// Tier precedence still holds: an explicit bank_preferred beats the sheet, so a
// wallet pick already applied is not re-locked by a stale wires cell.
test('lock: tier 1 wins over a stale legacy wires cell', () => {
  const row = { bank_preferred: 'hurupay', preferred_processor: null };
  assert.equal(
    isWalletRailLocked(resolveEffectivePayoutProcessor(row, { bankPreferredRaw: 'x1161' })),
    false,
  );
});
