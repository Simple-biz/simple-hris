export type PreferredBankRow = {
  preferred_bank_slot?: string | null;
  bank_name?: string | null;
  alt_bank_name?: string | null;
  account_holder_name?: string | null;
  alt_account_holder_name?: string | null;
  account_number?: string | null;
  alt_account_number?: string | null;
  swift_code?: string | null;
  alt_routing_number?: string | null;
};

export type PreferredBank = {
  name: string | null;
  holder: string | null;
  account: string | null;
  swift: string | null;
  isAlternativeSlot: boolean;
};

/**
 * The ONE cross-slot preferred-bank rule, shared by Accounting's People card and
 * the employee's own Profile. Preferred slot first, falling back to the OTHER
 * slot per field — the same pickFirst Payment Dispatch's queue row uses
 * (buildPayeeDetails in mock-queue.ts) — so a person whose details live only in
 * the non-preferred slot still shows the account PD actually pays to.
 *
 * There is no `alt_swift_code` column: the employee form stores the alternative
 * slot's wire code in `alt_routing_number` (EmployeeProfile.tsx savePaymentDetails,
 * `alt_routing_number: payout.altSwiftCode`), and `payoutDraftFromIdsRow`
 * (src/lib/employee/payout-completeness.ts) reads it back the same way
 * (`altSwiftCode: pick(row, 'alt_routing_number')`). So `alt_routing_number` is
 * the alternative slot's SWIFT-equivalent field, not a routing number, and the
 * cross-slot fallback for `swift` treats it exactly that way — the same shape
 * as every other field's primary<->alternative fallback.
 *
 * A second copy of this rule is the drift people-bank-card.md §2 exists to
 * prevent: the card would brand an account the money is not going to.
 */
export function pickPreferredBank(row: PreferredBankRow | null | undefined): PreferredBank {
  const alt = row?.preferred_bank_slot === 'alternative';
  const firstOf = (...vals: Array<string | null | undefined>): string | null =>
    vals.find((v) => v != null && String(v).trim() !== '') ?? null;

  return {
    name: alt ? firstOf(row?.alt_bank_name, row?.bank_name) : firstOf(row?.bank_name, row?.alt_bank_name),
    holder: alt
      ? firstOf(row?.alt_account_holder_name, row?.account_holder_name)
      : firstOf(row?.account_holder_name, row?.alt_account_holder_name),
    account: alt
      ? firstOf(row?.alt_account_number, row?.account_number)
      : firstOf(row?.account_number, row?.alt_account_number),
    // There is no `alt_swift_code` column: the employee form stores alt-slot
    // SWIFT in `alt_routing_number` (EmployeeProfile.tsx savePaymentDetails).
    // Before this fix PeopleTab.tsx read `swift_code` flat regardless of slot,
    // so an alternative-slot payee's card printed the PRIMARY slot's wire code
    // — and the copy button handed it over.
    swift: alt ? firstOf(row?.alt_routing_number, row?.swift_code) : firstOf(row?.swift_code, row?.alt_routing_number),
    isAlternativeSlot: alt,
  };
}
