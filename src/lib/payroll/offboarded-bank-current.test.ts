import test from 'node:test';
import assert from 'node:assert/strict';
import { readOffboardedBankCurrent } from './offboarded-bank-current';

const row = (over: Record<string, unknown>) => ({
  preferred_processor: null,
  bank_preferred: null,
  preferred_bank_slot: null,
  bank_name: null,
  account_holder_name: null,
  account_number: null,
  swift_code: null,
  alt_bank_name: null,
  alt_account_holder_name: null,
  alt_account_number: null,
  alt_routing_number: null,
  hurupay_email: null,
  higlobe_email: null,
  higlobe_account_name: null,
  wepay_email: null,
  ...over,
});

test('nothing on file => null', () => {
  assert.equal(readOffboardedBankCurrent(null), null);
  assert.equal(readOffboardedBankCurrent(null, { bankPreferredRaw: null }), null);
});

test('a full account number NEVER leaves the server - only the last four digits do', () => {
  const r = readOffboardedBankCurrent(
    row({ preferred_processor: 'wires', bank_name: 'Banco de Oro', account_holder_name: 'Joy R', account_number: '001234567890', swift_code: 'BNORPHMM' }),
  );
  assert.ok(r);
  assert.equal(r.processor, 'wires');
  assert.equal(r.bankName, 'Banco de Oro');
  assert.equal(r.accountHolder, 'Joy R');
  assert.equal(r.accountNumberMasked?.endsWith('7890'), true);
  assert.equal(r.accountNumberMasked?.includes('00123456'), false, 'the leading digits are hidden');
  assert.equal(r.swiftMasked?.includes('BNORPHMM'), false, 'SWIFT is tail-masked like People does');
  assert.equal(r.payable, true);
  const serialized = JSON.stringify(r);
  assert.equal(serialized.includes('001234567890'), false);
});

test('the readout is the PAID slot: alternative when preferred and populated', () => {
  const r = readOffboardedBankCurrent(
    row({
      preferred_processor: 'wise',
      preferred_bank_slot: 'alternative',
      bank_name: 'BPI',
      account_number: '1111',
      alt_bank_name: 'GoTyme Bank',
      alt_account_number: '22229999',
    }),
  );
  assert.ok(r);
  assert.equal(r.slot, 'alternative');
  assert.equal(r.bankName, 'GoTyme Bank');
  assert.equal(r.accountNumberMasked?.endsWith('9999'), true);
});

test('an empty preferred slot falls back to the other one, as dispatch displays it', () => {
  const r = readOffboardedBankCurrent(
    row({ preferred_processor: 'wires', preferred_bank_slot: 'alternative', bank_name: 'BPI', account_number: '5555' }),
  );
  assert.ok(r);
  assert.equal(r.slot, 'primary', 'alt slot is empty => show primary');
  assert.equal(r.bankName, 'BPI');
});

test('wallet rails read the effective rail email, masked, with the legacy sheet as fallback', () => {
  const kolan = readOffboardedBankCurrent(row({ preferred_processor: 'hurupay', hurupay_email: 'margauxcm0521@gmail.com' }));
  assert.ok(kolan);
  assert.equal(kolan.processor, 'hurupay');
  assert.equal(kolan.walletEmailMasked?.startsWith('m'), true);
  assert.equal(kolan.walletEmailMasked?.endsWith('@gmail.com'), true);
  assert.equal(kolan.walletEmailMasked?.includes('margauxcm0521'), false);
  assert.equal(kolan.payable, true);

  const viaSheet = readOffboardedBankCurrent(row({}), { bankPreferredRaw: 'HiGlobe', higlobeEmail: 'h@x.com', higlobeAccountName: 'H X' });
  assert.ok(viaSheet);
  assert.equal(viaSheet.processor, 'higlobe');
  assert.equal(viaSheet.walletName, 'H X');
  assert.equal(viaSheet.payable, true);
});

test('bank_preferred outranks preferred_processor - the same precedence dispatch routes on', () => {
  const r = readOffboardedBankCurrent(row({ preferred_processor: 'hurupay', bank_preferred: 'wise', bank_name: 'UnionBank', account_number: '777' }));
  assert.ok(r);
  assert.equal(r.processor, 'wise');
  assert.equal(r.walletEmailMasked, null, 'a wire rail has no wallet email to show');
});
