import {
  isProcessorId,
  processorIdFromBankPreferredText,
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
 * Legacy rates-sheet values Payment Dispatch falls back to when the
 * `employee_ids` row doesn't carry them (see mock-queue's buildQueueFromRates:
 * the legacy `bank_preferred` cell resolves the processor for anyone who never
 * picked one, and the rates-side hurupay/higlobe emails backfill the details).
 * Optional — callers without the rates row in hand just omit it.
 */
export interface PayoutLegacyExtras {
  bankPreferredRaw?: string | null;
  hurupayEmail?: string | null;
  higlobeEmail?: string | null;
  higlobeAccountName?: string | null;
}

/**
 * The processor Payment Dispatch would actually route this person on — the
 * SAME precedence as mock-queue's buildQueueFromRates: the employee's "Bank
 * Preferred" pick wins, then their Disbursement channel
 * (`preferred_processor`), then the legacy rates-sheet `bank_preferred` cell.
 * Null when none of the three resolves (PD would exclude them as `no_bank`).
 */
export function resolveEffectivePayoutProcessor(
  row: Record<string, unknown> | null | undefined,
  extras?: PayoutLegacyExtras,
): ProcessorId | null {
  const bankPreferred = row ? processorIdFromBankPreferredText(pick(row, 'bank_preferred')) : null;
  if (bankPreferred) return bankPreferred;
  const disbursement = row ? pick(row, 'preferred_processor').toLowerCase() : '';
  if (isProcessorId(disbursement)) return disbursement;
  return processorIdFromBankPreferredText(extras?.bankPreferredRaw);
}

/**
 * Whether this person carries enough payout detail to disburse pay — judged
 * the way Payment Dispatch actually pays, so this list never disagrees with
 * what accounting sees on the dispatch queue:
 *
 *   - Processor = PD's precedence (`bank_preferred` → `preferred_processor` →
 *     legacy rates cell), NOT `preferred_processor` alone. A stale Disbursement
 *     pick can't hide a person whose Bank Preferred routes them fine.
 *   - Wire bank details count from EITHER slot (PD's pickFirst falls back
 *     primary↔alternative when showing the payee's account).
 *   - hurupay/higlobe emails also count from the legacy rates row when the
 *     caller passes it (PD backfills details from there).
 *   - `wise` (like jeeves/wires, a non-wallet rail) is payable ONLY on full
 *     wire details — payouts go to the payee's bank account, never to a Wise
 *     email/@tag, so a stored handle alone doesn't make someone payable.
 *   - hurupay/higlobe stay strict: a wallet deposit needs its email, wire
 *     details can't substitute (that's the wires-flip cleanup, not payable).
 *
 * This is the single source of truth for "payable" used by the employee
 * portal's "complete your profile" nudge, the People tab's "Missing bank info"
 * list, and the Payroll Readiness "No Bank Info" check.
 */
export function isPayoutComplete(
  row: Record<string, unknown> | null | undefined,
  extras?: PayoutLegacyExtras,
): boolean {
  const processor = resolveEffectivePayoutProcessor(row, extras);
  if (!processor) return false;
  const payout = row ? payoutDraftFromIdsRow(row).payout : emptyPayout;
  // Wire details are payable from either bank slot — the preferred slot only
  // decides which account PD DISPLAYS first, not whether the person can be paid.
  const hasWireDetails =
    !!(payout.bankName || payout.altBankName) && !!(payout.accountNumber || payout.altAccountNumber);
  switch (processor) {
    case 'hurupay':
      return !!(payout.hurupayEmail || (extras?.hurupayEmail ?? '').trim());
    case 'wepay':
      return !!payout.wepayEmail;
    case 'higlobe':
      return (
        !!(payout.higlobeEmail || (extras?.higlobeEmail ?? '').trim()) &&
        !!(payout.higlobeAccountName || (extras?.higlobeAccountName ?? '').trim())
      );
    case 'wise':
    case 'jeeves':
    case 'wires':
      return hasWireDetails;
    default:
      return false;
  }
}

/**
 * What `isPayoutComplete` actually demands of each rail, in words — the caption on
 * the Bank changes "Receiving details on file" card, so a row that reads 391 of 419
 * also says what the other 28 are missing.
 *
 * **Keep this switch in the same shape as `isPayoutComplete` above.** They are two
 * views of one rule, and a caption that disagrees with the check is worse than no
 * caption: it tells Accounting to collect the wrong field.
 */
export type PayoutRequirement = 'wallet email' | 'email + account name' | 'bank + account';

export function payoutRequirementFor(processor: ProcessorId): PayoutRequirement {
  switch (processor) {
    case 'hurupay':
    case 'wepay':
      return 'wallet email';
    case 'higlobe':
      return 'email + account name';
    case 'wise':
    case 'jeeves':
    case 'wires':
      // Wise included: payouts land in the payee's bank account, never on a
      // Wise handle (see bank-preferred-routing.md §7).
      return 'bank + account';
  }
}

/**
 * Whether a rail deposits into a WALLET rather than the payee's own bank account.
 * Derived from the requirement above, so the two can never disagree.
 */
export function isWalletRail(processor: ProcessorId): boolean {
  return payoutRequirementFor(processor) !== 'bank + account';
}

/**
 * The RECEIVING account Payment Dispatch would actually show and pay to —
 * SLOT-AWARE, with the same cross-slot fallback PD's queue row uses
 * (`mock-queue.ts` preferredBankSlot + pickFirst, mirrored in the Payroll
 * Wizard's rate-snapshot card and the People Banking pane): the preferred slot
 * wins, the other slot backfills when it is empty.
 *
 * Resolving this any other way is the drift class the 2026-08-10 People-vs-PD
 * audit closed — 14 people sit on the alternative slot today and 8 of them
 * carry a DIFFERENT alt account number, so "just read account_number" prints
 * an account the payment is not going to.
 *
 * '' when neither slot carries a number — every wallet rail (Kolan/HiGlobe/
 * WePay deposit to a wallet email, not a bank account) and anyone with no bank
 * details on file. There is deliberately no legacy rates-sheet fallback: PD
 * backfills wallet EMAILS from that row, never account numbers.
 */
export function resolvePreferredAccountNumber(
  row: Record<string, unknown> | null | undefined,
): string {
  if (!row) return '';
  const { payout } = payoutDraftFromIdsRow(row);
  return payout.preferredBankSlot === 'alternative'
    ? payout.altAccountNumber || payout.accountNumber
    : payout.accountNumber || payout.altAccountNumber;
}
