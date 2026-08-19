import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveReceivingDestination } from '@/lib/employee/payout-completeness';
import { buildBankMix, normalizeBankNameKey } from './bank-mix';

/**
 * These pin the People → Bank changes KPI band against the rule
 * docs/features/bank-preferred-routing.md states in bold: Bank Preferred (the
 * SEND-FROM rail), the Disbursement election, and the RECEIVING account are three
 * different things. The band shows two of them side by side, so a single mistake
 * here is exactly the conflation the doc forbids.
 */

// ── Which rail (the "Preferred bank / send-from" card) ──────────────────────

test('send-from rail follows PD precedence: bank_preferred outranks the Disbursement pick', () => {
  const d = resolveReceivingDestination(
    { bank_preferred: 'hurupay', preferred_processor: 'wires', bank_name: 'BDO', account_number: '1234' },
    { bankPreferredRaw: 'Wise' },
  );
  assert.equal(d.kind, 'wallet');
  assert.equal(d.kind === 'wallet' && d.processor, 'hurupay');
});

test('send-from rail falls through to the legacy rates-sheet cell', () => {
  const d = resolveReceivingDestination({ bank_name: 'BPI' }, { bankPreferredRaw: 'x1153' });
  assert.equal(d.kind, 'bank');
  assert.equal(d.kind === 'bank' && d.processor, 'wires');
});

test('no rail at all is unrouted, not a bank and not a wallet', () => {
  const d = resolveReceivingDestination({ bank_name: 'BDO', account_number: '9' });
  assert.equal(d.kind, 'unrouted');
});

// ── Which receiving account (the "Receiving bank" card) ─────────────────────

test('a wallet payee has NO receiving bank — never counted as missing one', () => {
  const d = resolveReceivingDestination({ bank_preferred: 'higlobe', bank_name: 'Security Bank' });
  assert.equal(d.kind, 'wallet');

  const mix = buildBankMix([d]);
  assert.equal(mix.wallet, 1);
  assert.equal(mix.missingBank, 0);
  assert.equal(mix.bankRail, 0);
  assert.deepEqual(mix.receiving, []);
});

test('Wise is a BANK rail, not a wallet (Wise payouts land in the payee bank account)', () => {
  const d = resolveReceivingDestination({ bank_preferred: 'wise', bank_name: 'Metrobank', wise_email: 'a@b.com' });
  assert.equal(d.kind, 'bank');
  assert.equal(d.kind === 'bank' && d.bankName, 'Metrobank');
});

test('the ALTERNATE slot still yields a receiving bank (PD pickFirst falls back)', () => {
  const d = resolveReceivingDestination({ bank_preferred: 'wires', alt_bank_name: 'UnionBank' });
  assert.equal(d.kind, 'bank');
  assert.equal(d.kind === 'bank' && d.bankName, 'UnionBank');
});

test('preferred_bank_slot=alternative shows the ALT bank first', () => {
  const d = resolveReceivingDestination({
    bank_preferred: 'wires',
    preferred_bank_slot: 'alternative',
    bank_name: 'BDO',
    alt_bank_name: 'RCBC',
  });
  assert.equal(d.kind === 'bank' && d.bankName, 'RCBC');
});

test('a bank rail with no bank name in either slot is missing, not unrouted', () => {
  const d = resolveReceivingDestination({ bank_preferred: 'wires', account_number: '1234' });
  assert.equal(d.kind, 'missing');

  const mix = buildBankMix([d]);
  assert.equal(mix.missingBank, 1);
  assert.equal(mix.unrouted, 0);
  assert.equal(mix.bankRail, 1);
});

// ── Free-text grouping ─────────────────────────────────────────────────────

test('grouping is casefold + whitespace only; the popular spelling is the label', () => {
  const mix = buildBankMix([
    { kind: 'bank', processor: 'wires', bankName: 'BDO' },
    { kind: 'bank', processor: 'wires', bankName: 'bdo' },
    { kind: 'bank', processor: 'wires', bankName: 'BDO' },
    { kind: 'bank', processor: 'wires', bankName: '  BDO   Unibank ' },
  ]);
  assert.equal(mix.distinctBanks, 2);
  assert.deepEqual(
    mix.receiving.map((r) => [r.label, r.count]),
    [
      ['BDO', 3],
      ['BDO Unibank', 1],
    ],
  );
});

test('no alias table — BDO and Banco de Oro stay separate rather than being merged', () => {
  const mix = buildBankMix([
    { kind: 'bank', processor: 'wires', bankName: 'BDO' },
    { kind: 'bank', processor: 'wires', bankName: 'Banco de Oro' },
  ]);
  assert.equal(mix.distinctBanks, 2);
});

test('normalizeBankNameKey trims trailing punctuation but invents nothing', () => {
  assert.equal(normalizeBankNameKey('  Metrobank,  '), 'metrobank');
  assert.equal(normalizeBankNameKey('BPI Family Savings.'), 'bpi family savings');
  assert.equal(normalizeBankNameKey('.'), '');
});

test('a name that normalizes away entirely joins missingBank, never an empty slice', () => {
  const mix = buildBankMix([{ kind: 'bank', processor: 'wires', bankName: '.' }]);
  assert.equal(mix.missingBank, 1);
  assert.deepEqual(mix.receiving, []);
});

// ── Arithmetic the two cards are read against ──────────────────────────────

test('the mix balances: total = rails + unrouted, and rails = bankRail + wallet', () => {
  const mix = buildBankMix([
    { kind: 'bank', processor: 'wires', bankName: 'BDO' },
    { kind: 'bank', processor: 'wires', bankName: 'BDO' },
    { kind: 'bank', processor: 'wise', bankName: 'BPI' },
    { kind: 'missing', processor: 'wires' },
    { kind: 'wallet', processor: 'hurupay' },
    { kind: 'wallet', processor: 'higlobe' },
    { kind: 'wallet', processor: 'hurupay' },
    { kind: 'unrouted' },
  ]);

  const railTotal = mix.sending.reduce((s, r) => s + r.count, 0);
  const named = mix.receiving.reduce((s, r) => s + r.count, 0);

  assert.equal(mix.total, 8);
  assert.equal(mix.total, railTotal + mix.unrouted);
  assert.equal(railTotal, mix.bankRail + mix.wallet);
  assert.equal(named, mix.bankRail - mix.missingBank);

  assert.deepEqual(
    mix.sending.map((r) => [r.label, r.count]),
    [
      ['Wires', 3],
      ['Hurupay', 2],
      ['Higlobe', 1],
      ['Wise', 1],
    ],
  );
});

test('an empty roster produces zeros, not NaN or an undefined leader', () => {
  const mix = buildBankMix([]);
  assert.deepEqual(mix, {
    total: 0,
    sending: [],
    receiving: [],
    bankRail: 0,
    wallet: 0,
    missingBank: 0,
    unrouted: 0,
    distinctBanks: 0,
  });
});
