import { isProcessorId, type ProcessorId } from '@/lib/employee-payment-processors';

/**
 * What a payout READ view shows for a given rail.
 *
 * The two flags are independent, not exclusive: Jeeves is both — a bank card AND
 * a phone number — and neither implies the other.
 */
export type PayoutRailView = {
  /** Print the bank/wire field set as the branded card it describes. */
  showBankCard: boolean;
  /** Print the wallet identity fields (Kolan/WePay/HiGlobe email, Jeeves phone). */
  showWalletFields: boolean;
};

/**
 * What `payoutRailView` is told about the rail. THREE states, not two, and the
 * difference between the last two is what stops a contractor being handed a
 * bank card:
 *
 * - a `ProcessorId` — the rail resolved, and the table below decides;
 * - `null` — **nothing is stored on any tier.** Genuinely unassigned, so the
 *   bank-name fallback applies: if there is an account on the paid slot, print
 *   it;
 * - `'unrecognised'` — **something IS stored and it is not one of ours.** The
 *   fallback must NOT apply. `employee_ids.preferred_processor` also carries
 *   `'ach'`, the contractor-invoice US rail (see `ContractorProfile.tsx`), and
 *   an `'ach'` payee is not paid into the employee bank slot. Collapsing this
 *   into `null` would card them.
 */
export type PayoutRailInput = ProcessorId | 'unrecognised' | null;

/**
 * Narrow a RAW stored rail string to what `payoutRailView` accepts, preserving
 * the distinction a plain `isProcessorId` check destroys: empty means
 * unassigned, a non-empty value we do not know means unrecognised.
 *
 * For callers that already hold a typed `ProcessorId | null` (the employee
 * profile holds the server-resolved `walletRailEffective`) this is unnecessary —
 * that type is already assignable to `PayoutRailInput`.
 */
export function payoutRailFromStored(raw: string | null | undefined): PayoutRailInput {
  const stored = (raw ?? '').trim().toLowerCase();
  if (!stored) return null;
  return isProcessorId(stored) ? stored : 'unrecognised';
}

/**
 * Which payee gets a card, and who keeps their wallet fields.
 *
 * Lifted out of `PeopleTab.tsx`'s read view (the `showBank` const beside
 * `pickPreferredBank`) so the employee's own Payout section and Accounting's
 * People → Banking pane answer the question with ONE rule. A second copy is how
 * a Wise payee ends up with a card on one surface and none on the other.
 *
 * **`rail` is the EFFECTIVE, server-resolved rail** — `walletRailEffective`,
 * resolved across all three routing tiers (`bank_preferred` → the Disbursement
 * pick → the legacy rates cell). NEVER `preferredProcessor` and NEVER
 * `bankPreferred`: those three are distinct stored values and changing one never
 * changes the other, so judging the card off the raw Disbursement pick would
 * print the details of a rail the money does not travel on.
 *
 * | rail                        | card | wallet fields |
 * |-----------------------------|------|---------------|
 * | `wires`                     | yes  | no            |
 * | `wise`                      | yes  | no            |
 * | `jeeves`                    | yes  | yes (phone)   |
 * | `hurupay`/`wepay`/`higlobe` | no   | yes           |
 *
 * **Wise gets a card.** Wise payees are paid into their bank account, not to a
 * Wise handle — the same field set as `wires`, as the Readiness Set-bank editor
 * and the People → Banking editor both already assume. This is the one row that
 * is easy to get backwards, so the table above is pinned by the test file.
 *
 * **The wallet fields are never folded away.** For a Kolan, HiGlobe, WePay or
 * Jeeves payee there is no card and the wallet address IS the payout record;
 * collapsing it leaves the panel showing nothing but a button.
 *
 * **A missing rail fails closed.** `rail` is `null` both when the wallet payload
 * never arrived and when no tier resolved — the two are indistinguishable here,
 * so neither may be treated as "no rail, show everything". With no rail, nothing
 * wallet-shaped is ever invented, and a card appears only when there is an
 * actual bank name on the PAID slot to print. 1,124 people have no bank there:
 * they correctly get neither.
 *
 * **An unrecognised rail fails closed harder** — see `PayoutRailInput`. It is
 * not "unassigned", so it does not reach the bank-name fallback.
 */
export function payoutRailView(
  rail: PayoutRailInput,
  hasPaidSlotBankName: boolean,
): PayoutRailView {
  // Written as its own branch rather than left to fall through the equality
  // chain below, which would also return all-false today. The fallback is one
  // careless edit away from `(rail !== 'wires' && hasPaidSlotBankName)`, and the
  // day it is, an 'ach' contractor silently gets a bank card. Pinned by test.
  if (rail === 'unrecognised') return { showBankCard: false, showWalletFields: false };

  return {
    showBankCard:
      rail === 'wires' ||
      rail === 'wise' ||
      rail === 'jeeves' ||
      (!rail && hasPaidSlotBankName),
    showWalletFields:
      rail === 'hurupay' || rail === 'wepay' || rail === 'higlobe' || rail === 'jeeves',
  };
}
