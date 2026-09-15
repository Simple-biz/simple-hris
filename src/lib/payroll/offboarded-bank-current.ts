/**
 * The MASKED "currently on file" readout the Payroll Notes → Offboarded tab ships
 * beside each leaver, so "Set bank" can show what a save replaced and a re-opened
 * dialog can prove the save landed (2026-09-15 — the tab used to open the editor
 * blank every time, which read as *"it's not sticking at all"*).
 *
 * Masked on the SERVER, before the value leaves the process: the Offboarded
 * payload is readable by anyone holding the Payroll Wizard VIEW grant, and a full
 * account number has no business in a list payload (the Readiness activity feed
 * enforces the same rule — `readiness-activity-feed`). The masks are the ones
 * the People-tab "Bank changes" feed already uses (`mask-field.ts`), so the two
 * surfaces read the same digits. SWIFT / routing goes through the tail mask too
 * (People masks it — `people-banking.ts`).
 *
 * The readout is the PAID slot, resolved the way Payment Dispatch displays it:
 * the preferred slot first, falling back to the other one when the preferred slot
 * carries no account (`isPayoutComplete` accepts either slot).
 */
import { maskFieldValue } from '@/lib/bank-update/mask-field';
import {
  isPayoutComplete,
  payoutDraftFromIdsRow,
  resolveEffectivePayoutProcessor,
  type PayoutLegacyExtras,
} from '@/lib/employee/payout-completeness';
import type { ProcessorId } from '@/lib/employee-payment-processors';

export interface OffboardedBankCurrent {
  /** The rail Payment Dispatch would pay on today (bank_preferred → preferred_processor → legacy cell). */
  processor: ProcessorId | null;
  /** Which bank slot the wire readout below came from. */
  slot: 'primary' | 'alternative';
  bankName: string | null;
  accountHolder: string | null;
  /** Last 4 digits only. */
  accountNumberMasked: string | null;
  /** Tail-masked. */
  swiftMasked: string | null;
  /** First character + domain only. The wallet email of the EFFECTIVE rail. */
  walletEmailMasked: string | null;
  walletName: string | null;
  /** `isPayoutComplete` on the live row — what the tab's pill says. */
  payable: boolean;
}

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
};

/** Null when there is neither a live row nor a legacy rail — nothing is on file. */
export function readOffboardedBankCurrent(
  row: Record<string, unknown> | null | undefined,
  extras?: PayoutLegacyExtras,
): OffboardedBankCurrent | null {
  const processor = resolveEffectivePayoutProcessor(row, extras);
  if (!row && !processor) return null;
  const draft = row ? payoutDraftFromIdsRow(row).payout : null;

  // Paid slot: preferred first, the other slot when the preferred one is empty.
  let slot: 'primary' | 'alternative' = draft?.preferredBankSlot === 'alternative' ? 'alternative' : 'primary';
  const primaryHasAccount = !!clean(draft?.accountNumber) || !!clean(draft?.bankName);
  const altHasAccount = !!clean(draft?.altAccountNumber) || !!clean(draft?.altBankName);
  if (slot === 'alternative' && !altHasAccount && primaryHasAccount) slot = 'primary';
  if (slot === 'primary' && !primaryHasAccount && altHasAccount) slot = 'alternative';
  const wire =
    slot === 'alternative'
      ? { bank: draft?.altBankName, holder: draft?.altAccountHolderName, account: draft?.altAccountNumber, swift: draft?.altSwiftCode }
      : { bank: draft?.bankName, holder: draft?.accountHolderName, account: draft?.accountNumber, swift: draft?.swiftCode };

  let walletEmail: string | null = null;
  if (processor === 'hurupay') walletEmail = clean(draft?.hurupayEmail) ?? clean(extras?.hurupayEmail);
  else if (processor === 'wepay') walletEmail = clean(draft?.wepayEmail);
  else if (processor === 'higlobe') walletEmail = clean(draft?.higlobeEmail) ?? clean(extras?.higlobeEmail);
  const walletName =
    processor === 'higlobe' ? clean(draft?.higlobeAccountName) ?? clean(extras?.higlobeAccountName) : null;

  return {
    processor,
    slot,
    bankName: clean(wire.bank),
    accountHolder: clean(wire.holder),
    accountNumberMasked: maskFieldValue('account_number', clean(wire.account)),
    swiftMasked: maskFieldValue('routing_number', clean(wire.swift)),
    walletEmailMasked: walletEmail ? maskFieldValue('hurupay_email', walletEmail) : null,
    walletName,
    payable: isPayoutComplete(row, extras),
  };
}
