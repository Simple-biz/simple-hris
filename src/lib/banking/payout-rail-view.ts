import type { ProcessorId } from '@/lib/employee-payment-processors';

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
 */
export function payoutRailView(
  rail: ProcessorId | null,
  hasPaidSlotBankName: boolean,
): PayoutRailView {
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
