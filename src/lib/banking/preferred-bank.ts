export type PreferredBankRow = {
  preferred_bank_slot?: string | null;
  bank_name?: string | null;
  alt_bank_name?: string | null;
  account_holder_name?: string | null;
  alt_account_holder_name?: string | null;
  account_number?: string | null;
  alt_account_number?: string | null;
  swift_code?: string | null;
  routing_number?: string | null;
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
 * (buildPayeeDetails in mock-queue.ts, and identically buildPayoutDetails in
 * src/lib/payroll/urgent-payout-details.ts) — so a person whose details live
 * only in the non-preferred slot still shows the account PD actually pays to.
 *
 * `swift` is the one field with a THIRD rung, matching PD's chain exactly:
 * there is no `alt_swift_code` column, so the alternative slot's wire code
 * lives in `alt_routing_number` (the employee form writes
 * `alt_routing_number: payout.altSwiftCode` in EmployeeProfile.tsx
 * savePaymentDetails, and `payoutDraftFromIdsRow` in
 * src/lib/employee/payout-completeness.ts reads it back the same way:
 * `altSwiftCode: pick(row, 'alt_routing_number')`). PD additionally falls back
 * to `routing_number` as a last resort on BOTH slots (legacy rows entered
 * before `swift_code` existed as its own column) — `pickPreferredBank` mirrors
 * that third rung so the card can never disagree with what PD actually pays on.
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
    // Three rungs, matching PD's chain exactly (mock-queue.ts buildPayeeDetails
    // / urgent-payout-details.ts buildPayoutDetails). Before this fix
    // PeopleTab.tsx read `swift_code` flat regardless of slot, so an
    // alternative-slot payee's card printed the PRIMARY slot's wire code — and
    // the copy button handed it over.
    swift: alt
      ? firstOf(row?.alt_routing_number, row?.swift_code, row?.routing_number)
      : firstOf(row?.swift_code, row?.routing_number, row?.alt_routing_number),
    isAlternativeSlot: alt,
  };
}

/** The two columns families `employee_ids` keeps a bank account in. */
export type BankSlotId = 'primary' | 'alternative';

/** Which slot Payment Dispatch actually pays. Stored value, defaulted closed. */
export function paidBankSlot(row: PreferredBankRow | null | undefined): BankSlotId {
  return row?.preferred_bank_slot === 'alternative' ? 'alternative' : 'primary';
}

/**
 * The RAW read of ONE slot — deliberately WITHOUT `pickPreferredBank`'s
 * cross-slot fallback, and never a replacement for it.
 *
 * `pickPreferredBank` answers "what account does the money land in", and it
 * falls back field-by-field into the other slot so a half-filled record still
 * names the account PD pays. That is exactly the wrong answer when the two
 * slots are being shown SIDE BY SIDE: a backup card built from it would borrow
 * the paid slot's bank name and print two cards claiming one bank, which is the
 * invented equivalence `people-bank-card.md` §2 exists to forbid.
 *
 * So this reads one slot and stops. The only chain kept is the primary slot's
 * `swift_code → routing_number`, because both of those columns belong to that
 * same slot (rows entered before `swift_code` existed put the wire code in
 * `routing_number`); the alternative slot has no second column to fall to — its
 * wire code IS `alt_routing_number`.
 *
 * Use it for the card the money is NOT going to. The paid card stays
 * `pickPreferredBank`, so the front of the deck can never disagree with what
 * this surface printed before the deck existed.
 */
export function readBankSlot(
  row: PreferredBankRow | null | undefined,
  slot: BankSlotId,
): PreferredBank {
  const clean = (v: string | null | undefined): string | null => {
    const t = v == null ? '' : String(v).trim();
    return t === '' ? null : t;
  };

  if (slot === 'alternative') {
    return {
      name: clean(row?.alt_bank_name),
      holder: clean(row?.alt_account_holder_name),
      account: clean(row?.alt_account_number),
      swift: clean(row?.alt_routing_number),
      isAlternativeSlot: true,
    };
  }
  return {
    name: clean(row?.bank_name),
    holder: clean(row?.account_holder_name),
    account: clean(row?.account_number),
    swift: clean(row?.swift_code) ?? clean(row?.routing_number),
    isAlternativeSlot: false,
  };
}

/** A slot worth printing a card for: it names a bank, an account, or both. */
export function bankSlotHasAccount(bank: PreferredBank): boolean {
  return !!(bank.name || bank.account);
}

/**
 * Whether two resolved slots describe the SAME account.
 *
 * The deck only earns its second card when the backup is genuinely a different
 * destination. A record whose details live only in one slot resolves — through
 * `pickPreferredBank`'s fallback — to that same account on both, and showing it
 * twice would invent a redundancy Accounting could act on.
 */
export function sameBankAccount(a: PreferredBank, b: PreferredBank): boolean {
  return (a.account ?? '') === (b.account ?? '') && (a.name ?? '') === (b.name ?? '');
}
