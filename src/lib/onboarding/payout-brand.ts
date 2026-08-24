/**
 * Which payout-wallet brand a hire's onboarding paperwork was signed under.
 *
 * Hurupay rebranded to Kolan on 2026-08-24. Every live surface reads "Kolan",
 * but a submitted onboarding record is a historical document: someone who
 * signed in June agreed to be paid via "Hurupay", and HR's copy has to keep
 * saying so (Kane, 2026-08-24).
 *
 * This is a DISPLAY stamp and nothing else. Routing keys on
 * `payment_method` / `employee_ids.bank_preferred`, which stay `'hurupay'` for
 * both brands — see docs/features/bank-preferred-routing.md §4.
 */

/** Stored stamp values. `null` on every row written before the rebrand. */
export type PayoutBrand = 'hurupay' | 'kolan';

/** What new paperwork is stamped with. Bump this at the next rebrand. */
export const CURRENT_PAYOUT_BRAND: PayoutBrand = 'kolan';

/**
 * The brand name to print for a stored stamp.
 *
 * Anything unrecognised — `null`, `undefined`, `''`, or a value from a future
 * schema this build predates — reads as **Hurupay**, because the only rows that
 * can lack a valid stamp are the pre-rebrand ones. Defaulting the other way
 * would silently retitle historical paperwork.
 */
export function payoutBrandLabel(stamp: string | null | undefined): string {
  return String(stamp ?? '').trim().toLowerCase() === 'kolan' ? 'Kolan' : 'Hurupay';
}
