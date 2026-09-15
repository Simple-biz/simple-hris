import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_BANK_OVERRIDE_TYPED,
  buildBankOverridePatch,
  validateBankOverride,
  type BankOverrideOnFile,
} from './bank-override-patch';

const typed = (over: Partial<typeof EMPTY_BANK_OVERRIDE_TYPED>) => ({ ...EMPTY_BANK_OVERRIDE_TYPED, ...over });
const onFile = (over: Partial<BankOverrideOnFile>): BankOverrideOnFile => ({
  processor: null,
  hasBankName: false,
  hasAccountNumber: false,
  hasWalletEmail: false,
  hasWalletName: false,
  ...over,
});

// ── validation: typed OR on file ─────────────────────────────────────────────

test('a rail is required', () => {
  const r = validateBankOverride('', typed({}), null);
  assert.equal(r.ok, false);
});

test('wire rails accept on-file bank + account when nothing is typed', () => {
  const file = onFile({ processor: 'hurupay', hasBankName: true, hasAccountNumber: true });
  assert.equal(validateBankOverride('wires', typed({}), file).ok, true, 'wire columns are shared - the on-file rail does not matter');
  assert.equal(validateBankOverride('wise', typed({}), file).ok, true);
  assert.equal(validateBankOverride('wires', typed({}), onFile({ hasBankName: true })).ok, false, 'account missing on file and untyped');
  assert.equal(validateBankOverride('wires', typed({ accountNumber: '123' }), onFile({ hasBankName: true })).ok, true);
});

test('a wallet email on file only satisfies the SAME rail', () => {
  const kolanOnFile = onFile({ processor: 'hurupay', hasWalletEmail: true });
  assert.equal(validateBankOverride('hurupay', typed({}), kolanOnFile).ok, true);
  assert.equal(validateBankOverride('higlobe', typed({}), kolanOnFile).ok, false, 'a Kolan email cannot fund a HiGlobe deposit');
  assert.equal(validateBankOverride('higlobe', typed({ walletEmail: 'a@b.c' }), kolanOnFile).ok, false, 'HiGlobe also needs the account name');
  assert.equal(validateBankOverride('higlobe', typed({ walletEmail: 'a@b.c', walletName: 'A B' }), kolanOnFile).ok, true);
});

// ── the patch pins BOTH routing columns and only typed details ───────────────

test('the patch pins receiving AND send-from to the chosen rail', () => {
  const p = buildBankOverridePatch('wires', typed({ bankName: 'BDO', accountNumber: '0099' }));
  assert.equal(p.preferred_processor, 'wires');
  assert.equal(p.bank_preferred, 'wires', 'a stale bank_preferred must never outrank the chosen rail');
  assert.equal(p.bank_name, 'BDO');
  assert.equal(p.account_number, '0099');
  assert.equal(p.preferred_bank_slot, 'primary', 'the typed account is the paid slot');
  assert.equal('account_holder_name' in p, false, 'untyped fields are not sent - the stored value stays');
});

test('a wallet rail writes only its own email column', () => {
  const p = buildBankOverridePatch('hurupay', typed({ walletEmail: ' k@x.com ', bankName: 'ignored' }));
  assert.deepEqual(p, { preferred_processor: 'hurupay', bank_preferred: 'hurupay', hurupay_email: 'k@x.com' });
  const h = buildBankOverridePatch('higlobe', typed({ walletEmail: 'h@x.com', walletName: 'Holder' }));
  assert.equal(h.higlobe_email, 'h@x.com');
  assert.equal(h.higlobe_account_name, 'Holder');
  assert.equal('preferred_bank_slot' in h, false, 'wallet saves never touch the bank slot pointer');
});

test('a wire rail with nothing typed leaves the slot pointer alone', () => {
  const p = buildBankOverridePatch('wise', typed({}));
  assert.deepEqual(p, { preferred_processor: 'wise', bank_preferred: 'wise' });
});

test('no receiving column is ever written that the clerk did not type', () => {
  const p = buildBankOverridePatch('jeeves', typed({ swiftCode: 'BOPIPHMM' }));
  const receiving = ['bank_name', 'account_number', 'account_holder_name', 'hurupay_email', 'higlobe_email', 'wepay_email'];
  for (const k of receiving) assert.equal(k in p, false, `${k} must not be written`);
  assert.equal(p.swift_code, 'BOPIPHMM');
});
