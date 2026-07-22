/**
 * Maps the Mark Paid modal's profile-override values to employee_ids columns.
 *
 * `target` mirrors what the modal displayed (see resolveMarkPaidDefaults):
 * 'bank' = wire details (wires / jeeves / wise-routed employee whose payout is
 * their own bank), 'wallet' = the processor's wallet fields. The caller (the
 * bank-override route) resolves `preferredBankSlot` from the employee's row so
 * the write lands on the ACTIVE slot — primary or alternative — matching what
 * the dispatch queue displayed.
 *
 * Trimmed-empty optional values map to null (an explicit clear — the fields
 * are prefilled from the current values, so an emptied field is deliberate).
 * Routing columns (bank_preferred / preferred_processor) are NEVER produced.
 */

export type BankOverrideTarget = 'bank' | 'wallet';

export interface BankOverrideValues {
  preferredBank?: string | null;
  accountNumber: string;
  accountHolder?: string | null;
  swiftCode?: string | null;
}

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
};

export function mapBankOverrideToColumns(opts: {
  target: BankOverrideTarget;
  processor: string;
  preferredBankSlot: 'primary' | 'alternative';
  values: BankOverrideValues;
}): { columns: Record<string, string | null> } | { error: string } {
  const { target, processor, preferredBankSlot, values } = opts;
  const accountNumber = clean(values.accountNumber);
  if (!accountNumber) return { error: 'Account / wallet ID is required' };

  if (target === 'bank') {
    if (preferredBankSlot === 'alternative') {
      return {
        columns: {
          alt_bank_name: clean(values.preferredBank),
          alt_account_holder_name: clean(values.accountHolder),
          alt_account_number: accountNumber,
          alt_routing_number: clean(values.swiftCode),
        },
      };
    }
    return {
      columns: {
        bank_name: clean(values.preferredBank),
        account_holder_name: clean(values.accountHolder),
        account_number: accountNumber,
        swift_code: clean(values.swiftCode),
      },
    };
  }

  switch (processor) {
    case 'hurupay':
      return { columns: { hurupay_email: accountNumber } };
    case 'wepay':
      return { columns: { wepay_email: accountNumber } };
    case 'higlobe':
      return {
        columns: { higlobe_email: accountNumber, higlobe_account_name: clean(values.accountHolder) },
      };
    case 'wise':
      return {
        columns: { wise_email: accountNumber, account_holder_name: clean(values.accountHolder) },
      };
    default:
      return { error: `No wallet mapping for processor "${processor}"` };
  }
}
