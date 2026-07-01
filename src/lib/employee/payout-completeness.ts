import {
  isProcessorId,
  type ProcessorId,
} from '@/lib/employee-payment-processors';

/**
 * Pure, server-safe payout-field model + completeness check, hoisted out of the
 * `'use client'` employee-payout-fields.tsx so BOTH the employee portal and
 * server code (the People roster) can share ONE definition of "can this person
 * actually be paid?". Keeping two copies is exactly how the People "Missing bank
 * info" list and the employee's own nudge drifted apart.
 */
export interface PayoutFields {
  preferredBankSlot: 'primary' | 'alternative';
  hurupayEmail: string;
  wepayEmail: string;
  higlobeEmail: string;
  higlobeAccountName: string;
  wiseEmail: string;
  wiseTag: string;
  phoneNumber: string;
  fullAddress: string;
  bankName: string;
  accountHolderName: string;
  accountNumber: string;
  swiftCode: string;
  altBankName: string;
  altAccountHolderName: string;
  altAccountNumber: string;
  altSwiftCode: string;
}

export const emptyPayout: PayoutFields = {
  preferredBankSlot: 'primary',
  hurupayEmail: '',
  wepayEmail: '',
  higlobeEmail: '',
  higlobeAccountName: '',
  wiseEmail: '',
  wiseTag: '',
  phoneNumber: '',
  fullAddress: '',
  bankName: '',
  accountHolderName: '',
  accountNumber: '',
  swiftCode: '',
  altBankName: '',
  altAccountHolderName: '',
  altAccountNumber: '',
  altSwiftCode: '',
};

function pick(row: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return '';
}

/** Deserialize payout draft + processor from an `employee_ids` row. */
export function payoutDraftFromIdsRow(row: Record<string, unknown>): {
  preferredProcessor: ProcessorId | '';
  payout: PayoutFields;
} {
  const stored = pick(row, 'preferred_processor').toLowerCase();
  return {
    preferredProcessor: isProcessorId(stored) ? stored : '',
    payout: {
      hurupayEmail: pick(row, 'hurupay_email'),
      wepayEmail: pick(row, 'wepay_email'),
      higlobeEmail: pick(row, 'higlobe_email'),
      higlobeAccountName: pick(row, 'higlobe_account_name'),
      wiseEmail: pick(row, 'wise_email'),
      wiseTag: pick(row, 'wise_tag'),
      phoneNumber: pick(row, 'phone_number'),
      fullAddress: pick(row, 'full_address'),
      bankName: pick(row, 'bank_name'),
      accountHolderName: pick(row, 'account_holder_name'),
      accountNumber: pick(row, 'account_number'),
      swiftCode: pick(row, 'swift_code', 'routing_number'),
      preferredBankSlot: pick(row, 'preferred_bank_slot') === 'alternative' ? 'alternative' : 'primary',
      altBankName: pick(row, 'alt_bank_name'),
      altAccountHolderName: pick(row, 'alt_account_holder_name'),
      altAccountNumber: pick(row, 'alt_account_number'),
      altSwiftCode: pick(row, 'alt_routing_number'),
    },
  };
}

/**
 * Whether an `employee_ids` row carries enough payout detail to disburse pay.
 * A preferred processor must be set, plus the identifying field(s) that
 * processor actually needs (see PROCESSOR_OPTIONS blurbs). This is the single
 * source of truth for "payable" used by the employee portal's "complete your
 * profile" nudge AND the People tab's "Missing bank info" list.
 */
export function isPayoutComplete(row: Record<string, unknown> | null | undefined): boolean {
  if (!row) return false;
  const { preferredProcessor, payout } = payoutDraftFromIdsRow(row);
  if (!preferredProcessor) return false;
  switch (preferredProcessor) {
    case 'hurupay':
      return !!payout.hurupayEmail;
    case 'wepay':
      return !!payout.wepayEmail;
    case 'higlobe':
      return !!(payout.higlobeEmail && payout.higlobeAccountName);
    case 'wise':
      return !!(payout.wiseEmail || payout.wiseTag);
    case 'jeeves':
    case 'wires':
      return payout.preferredBankSlot === 'alternative'
        ? !!(payout.altBankName && payout.altAccountNumber)
        : !!(payout.bankName && payout.accountNumber);
    default:
      return false;
  }
}
