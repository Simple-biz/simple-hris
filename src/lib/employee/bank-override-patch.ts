/**
 * The Payroll Notes → Offboarded tab's "Set bank" in COMPLETE-OVERRIDE mode
 * (2026-09-15, Kane: *"Set banks should be a complete override"*).
 *
 * A leaver has no self-service surface left and nobody to file a Bank Preferred
 * request for, so the Offboarded tab is the ONLY place Accounting can decide how
 * a final check is paid. In override mode the rail is the clerk's to pick and the
 * save goes through the Accounting direct-edit route (`PATCH
 * /api/people/[email]/banking`), where an Accounting edit IS the approval
 * (bank-preferred-routing.md §8) and the 1:1 rule is enforced server-side.
 *
 * Pure so the two decisions are provable:
 *
 *   • VALIDATION — what the rail needs is satisfied by what the clerk typed OR
 *     by what is already on file for that rail. Wire details are shared columns,
 *     so on-file bank+account satisfy Wise / Jeeves / Wires alike; a wallet email
 *     lives in a per-rail column, so on-file only counts when the on-file rail IS
 *     the chosen rail.
 *   • THE PATCH — writes BOTH `preferred_processor` (receiving) and
 *     `bank_preferred` (send-from) to the chosen rail, so a pre-existing send-from
 *     can never outrank the clerk's choice (routing precedence is
 *     `bank_preferred` > `preferred_processor`). Equal values are always legal
 *     under the 1:1 rule. When any PRIMARY wire field is typed the paid slot is
 *     pinned to `primary`: Payment Dispatch displays the preferred slot first, so a
 *     stale `alternative` pointer would send the money to the OLD account beside
 *     the new one the clerk just typed. Nothing here ever writes a receiving
 *     column the clerk did not type.
 */
import { isWalletRail } from '@/lib/employee/payout-completeness';
import type { ProcessorId } from '@/lib/employee-payment-processors';

/** What the clerk typed — empty string means "left blank". */
export interface BankOverrideTyped {
  walletEmail: string;
  walletName: string;
  bankName: string;
  accountHolder: string;
  accountNumber: string;
  swiftCode: string;
}

/** Presence of each field on the LIVE row (masked readout — values never needed here). */
export interface BankOverrideOnFile {
  processor: ProcessorId | null;
  hasBankName: boolean;
  hasAccountNumber: boolean;
  hasWalletEmail: boolean;
  hasWalletName: boolean;
}

export const EMPTY_BANK_OVERRIDE_TYPED: BankOverrideTyped = {
  walletEmail: '',
  walletName: '',
  bankName: '',
  accountHolder: '',
  accountNumber: '',
  swiftCode: '',
};

const t = (v: string) => v.trim();

export function validateBankOverride(
  rail: string,
  typed: BankOverrideTyped,
  onFile: BankOverrideOnFile | null,
  railLabel: string = rail,
): { ok: true } | { ok: false; error: string } {
  if (!rail) return { ok: false, error: 'Pick the processor this person is paid through.' };
  const sameRailOnFile = onFile?.processor === rail;
  if (isWalletRail(rail as ProcessorId)) {
    if (!t(typed.walletEmail) && !(sameRailOnFile && onFile?.hasWalletEmail)) {
      return { ok: false, error: `Enter the ${railLabel} account email.` };
    }
    if (rail === 'higlobe' && !t(typed.walletName) && !(sameRailOnFile && onFile?.hasWalletName)) {
      return { ok: false, error: 'Enter the HiGlobe account name.' };
    }
    return { ok: true };
  }
  const bankOk = !!t(typed.bankName) || !!onFile?.hasBankName;
  const acctOk = !!t(typed.accountNumber) || !!onFile?.hasAccountNumber;
  if (!bankOk || !acctOk) return { ok: false, error: 'Bank name and account number are required.' };
  return { ok: true };
}

/**
 * The `patch` body for `PATCH /api/people/[email]/banking`. Only typed fields
 * are sent (an untouched field keeps its stored value); the two routing columns
 * are always sent, pinned to the chosen rail.
 */
export function buildBankOverridePatch(rail: ProcessorId, typed: BankOverrideTyped): Record<string, string> {
  const patch: Record<string, string> = {
    preferred_processor: rail,
    bank_preferred: rail,
  };
  if (isWalletRail(rail)) {
    const email = t(typed.walletEmail);
    if (rail === 'hurupay' && email) patch.hurupay_email = email;
    if (rail === 'wepay' && email) patch.wepay_email = email;
    if (rail === 'higlobe') {
      if (email) patch.higlobe_email = email;
      if (t(typed.walletName)) patch.higlobe_account_name = t(typed.walletName);
    }
    return patch;
  }
  let wroteWire = false;
  if (t(typed.bankName)) {
    patch.bank_name = t(typed.bankName);
    wroteWire = true;
  }
  if (t(typed.accountNumber)) {
    patch.account_number = t(typed.accountNumber);
    wroteWire = true;
  }
  if (t(typed.accountHolder)) {
    patch.account_holder_name = t(typed.accountHolder);
    wroteWire = true;
  }
  if (t(typed.swiftCode)) {
    patch.swift_code = t(typed.swiftCode);
    wroteWire = true;
  }
  // The typed account is the one to pay. Dispatch shows the preferred slot
  // first, so leaving a stale `alternative` pointer in place would route the
  // money past what the clerk just entered.
  if (wroteWire) patch.preferred_bank_slot = 'primary';
  return patch;
}
