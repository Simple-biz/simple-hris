import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPayeeDetails } from '@/components/payroll-clerk/mock-queue';
import type { EmployeeIdRow } from '@/lib/supabase/employee-ids';
import { PENDING_COLUMNS } from './dispatch-client-csv';

/**
 * Payment Dispatch shows the payee's OTHER bank account in the expanded row, so a
 * clerk whose payment bounced can see what else is on file without leaving the
 * worksheet (Kane, 2026-09-13, and `payment-dispatch.md` §3.4.4).
 *
 * Two ways that block can lie, and both put money in the wrong place:
 *
 *   1. **It echoes the account that just failed.** `buildPayeeDetails` resolves
 *      the PAID slot with a cross-slot fallback, so a record half-filled in one
 *      slot resolves to the same account from either side. Offering that back as
 *      a "backup" tells a clerk to retry the account that bounced.
 *   2. **It is labelled `alt` when the alternative slot is the one being PAID.**
 *      17 live payees are in exactly that state; for them the backup is the
 *      PRIMARY columns, and `backup_slot` has to say so.
 */

const BLANK: EmployeeIdRow = {
  work_email: 'person@simple.biz',
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
} as unknown as EmployeeIdRow;

const details = (row: Partial<EmployeeIdRow>) =>
  buildPayeeDetails('person@simple.biz', { ...BLANK, ...row } as EmployeeIdRow);

test('two real accounts: the backup is the slot that is NOT being paid', () => {
  const d = details({
    preferred_bank_slot: 'primary',
    bank_name: 'GoTyme Bank', account_holder_name: 'Ana Cruz',
    account_number: '001234567890', swift_code: 'GOTYPHM1',
    alt_bank_name: 'BDO Unibank', alt_account_holder_name: 'Ana S. Cruz',
    alt_account_number: '9988776655', alt_routing_number: 'BNORPHMM',
  });
  assert.equal(d.account_number, '001234567890');
  assert.equal(d.backup_slot, 'Alternative');
  assert.equal(d.backup_bank_name, 'BDO Unibank');
  assert.equal(d.backup_account_holder_name, 'Ana S. Cruz');
  assert.equal(d.backup_account_number, '9988776655');
  assert.equal(d.backup_swift_code, 'BNORPHMM');
});

test('paid out of the ALTERNATIVE slot: the backup is the PRIMARY, and says so', () => {
  // 17 live payees. Calling this block "alternative" here would name the account
  // the money IS going to.
  const d = details({
    preferred_bank_slot: 'alternative',
    bank_name: 'GoTyme Bank', account_number: '001234567890', swift_code: 'GOTYPHM1',
    alt_bank_name: 'BDO Unibank', alt_account_number: '9988776655', alt_routing_number: 'BNORPHMM',
  });
  assert.equal(d.account_number, '9988776655', 'the paid account is still the alternative slot');
  assert.equal(d.backup_slot, 'Primary');
  assert.equal(d.backup_bank_name, 'GoTyme Bank');
  assert.equal(d.backup_account_number, '001234567890');
  assert.equal(d.backup_swift_code, 'GOTYPHM1');
});

test('one account spread across the record offers NO backup', () => {
  // The stored preference says alternative, the details live in the primary
  // columns, and the cross-slot fallback pays the primary account. The "other"
  // slot is that same account — offering it back is telling a clerk to retry
  // what just failed.
  const d = details({
    preferred_bank_slot: 'alternative',
    bank_name: 'GoTyme Bank', account_number: '001234567890',
  });
  assert.equal(d.account_number, '001234567890');
  assert.equal(d.backup_slot, undefined);
  assert.equal(d.backup_bank_name, undefined);
  assert.equal(d.backup_account_number, undefined);
});

test('no second slot at all leaves every backup field undefined', () => {
  const d = details({
    bank_name: 'GoTyme Bank', account_number: '001234567890', swift_code: 'GOTYPHM1',
  });
  assert.equal(d.backup_slot, undefined);
  assert.equal(d.backup_bank_name, undefined);
  assert.equal(d.backup_account_holder_name, undefined);
  assert.equal(d.backup_account_number, undefined);
  assert.equal(d.backup_swift_code, undefined);
});

test('a wallet payee with a bank on file still gets the backup block', () => {
  // Kolan/Higlobe are email-only rails. A failed wallet payment is exactly when a
  // clerk wants to know a bank account exists, so the block is gated on the DATA,
  // never on the rail — the fields are plain text and claim no rail.
  const d = details({
    hurupay_email: 'payee@gmail.com',
    bank_name: 'BPI', account_number: '1111222233',
    alt_bank_name: 'GCash', alt_account_number: '09171234567',
  });
  assert.equal(d.backup_slot, 'Alternative');
  assert.equal(d.backup_bank_name, 'GCash');
});

test('the backup fields never fall back across slots', () => {
  // `readBankSlot` reads one slot and stops. A backup holding a bank name only
  // must NOT borrow the paid slot's holder or account number to look complete.
  const d = details({
    bank_name: 'GoTyme Bank', account_holder_name: 'Ana Cruz', account_number: '001234567890',
    alt_bank_name: 'BDO Unibank',
  });
  assert.equal(d.backup_bank_name, 'BDO Unibank');
  assert.equal(d.backup_account_holder_name, undefined);
  assert.equal(d.backup_account_number, undefined);
});

test('every backup field the expanded row reveals has a pending CSV column', () => {
  // payment-dispatch.md §4.2.3(b): nothing on a screen vanishes from that
  // screen's own export. §4.2.3(c)'s structural guard only covers
  // `PROCESSORS[].detailFields`, and the backup block is deliberately NOT in that
  // list — so its coverage is asserted here instead of going unguarded.
  const exported = new Set(PENDING_COLUMNS.map((c) => c.key));
  for (const key of [
    'backup_slot',
    'backup_bank',
    'backup_account_holder',
    'backup_account_number',
    'backup_swift_code',
  ]) {
    assert.ok(exported.has(key), `the expanded row shows a backup ${key} with no CSV column`);
  }
});

test('the backup headers say they are not the destination', () => {
  // The file is the HRIS-vs-Google-Sheet validation artifact. A column called
  // "Bank" beside "Account Number / Wallet" would read as a second place the
  // money might have gone.
  for (const c of PENDING_COLUMNS.filter((c) => c.key.startsWith('backup_'))) {
    assert.match(c.header, /not paid/i, `${c.header} must say it is not this row's destination`);
  }
});
