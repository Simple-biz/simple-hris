import test from 'node:test';
import assert from 'node:assert/strict';
import { pickPreferredBank, type PreferredBankRow } from './preferred-bank';
import { buildPayoutDetails, type IdsRow } from '@/lib/payroll/urgent-payout-details';

/**
 * `pickPreferredBank`'s `swift` field must never drift from what Payment
 * Dispatch itself resolves — that drift (a two-rung helper next to PD's real
 * three-rung chain) is exactly what code review caught after the initial cut
 * of this helper. Asserting against `buildPayoutDetails` directly (PD's own,
 * exported chain in src/lib/payroll/urgent-payout-details.ts — byte-identical
 * to the unexported `buildPayeeDetails` in mock-queue.ts) means the two cannot
 * silently re-diverge: this test fails the moment either chain changes without
 * the other.
 */
const BLANK_IDS_ROW: IdsRow = {
  work_email: 'person@example.com',
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

function pdSwift(row: IdsRow): string | null {
  return buildPayoutDetails(row, row.work_email ?? 'person@example.com').swift_code ?? null;
}

function assertSwiftMatchesPd(row: IdsRow) {
  const ourRow: PreferredBankRow = row;
  assert.equal(pickPreferredBank(ourRow).swift, pdSwift(row));
}

test('empty row: both resolve to null', () => {
  assertSwiftMatchesPd({ ...BLANK_IDS_ROW });
});

test('primary slot, only swift_code populated', () => {
  assertSwiftMatchesPd({ ...BLANK_IDS_ROW, preferred_bank_slot: 'primary', swift_code: 'BNORPHMM' });
});

test('primary slot, only routing_number populated (legacy row, no swift_code yet)', () => {
  assertSwiftMatchesPd({ ...BLANK_IDS_ROW, preferred_bank_slot: 'primary', routing_number: 'RTN000111' });
});

test('primary slot, only alt_routing_number populated (last-resort rung)', () => {
  assertSwiftMatchesPd({ ...BLANK_IDS_ROW, preferred_bank_slot: 'primary', alt_routing_number: 'PAPHPHM1' });
});

test('primary slot, all three rungs populated — swift_code wins', () => {
  assertSwiftMatchesPd({
    ...BLANK_IDS_ROW,
    preferred_bank_slot: 'primary',
    swift_code: 'BNORPHMM',
    routing_number: 'RTN000111',
    alt_routing_number: 'PAPHPHM1',
  });
});

test('alternative slot, only alt_routing_number populated', () => {
  assertSwiftMatchesPd({ ...BLANK_IDS_ROW, preferred_bank_slot: 'alternative', alt_routing_number: 'PAPHPHM1' });
});

test('alternative slot, only swift_code populated (falls back to primary)', () => {
  assertSwiftMatchesPd({ ...BLANK_IDS_ROW, preferred_bank_slot: 'alternative', swift_code: 'BNORPHMM' });
});

test('alternative slot, only routing_number populated (last-resort rung)', () => {
  assertSwiftMatchesPd({ ...BLANK_IDS_ROW, preferred_bank_slot: 'alternative', routing_number: 'RTN000111' });
});

test('alternative slot, all three rungs populated — alt_routing_number wins', () => {
  assertSwiftMatchesPd({
    ...BLANK_IDS_ROW,
    preferred_bank_slot: 'alternative',
    swift_code: 'BNORPHMM',
    routing_number: 'RTN000111',
    alt_routing_number: 'PAPHPHM1',
  });
});
