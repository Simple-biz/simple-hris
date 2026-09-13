/**
 * The ONE masking rule for a stored payout identifier — the account number and
 * the wire code printed beside it.
 *
 * Extracted rather than retyped because two components now render the SAME
 * number on the SAME pane: `src/components/banking/bank-card.tsx` is the payout
 * section's READ view and `src/components/employee/employee-payout-fields.tsx`
 * is its EDIT view, and the form still masks its own fields whenever it renders
 * disabled. Two private copies of "what masked means" is exactly the drift where
 * one half of a pane shows `••••7890` and the other `••••••7890` for a single
 * account, and the reader has no way to tell which characters are the real ones.
 *
 * **Characters, not digits.** The value is masked exactly as stored, separators
 * included, because the account number is never reformatted anywhere on this
 * card — no 4-4-4-4 grouping, leading zeros preserved (see the header comment in
 * bank-card.tsx). The local rule this replaces stripped `-` and spaces BEFORE
 * counting, so a stored `1234-5678-9012` masked down to a 12-character string
 * that no longer described the 14-character value underneath it. Counting
 * characters keeps the mask the same shape as the thing it hides.
 *
 * Dropping that strip can only ever reveal LESS, never more: when one of the
 * last four characters is a separator, three digits show instead of four. It is
 * a tightening, and `account-mask.test.ts` pins it so nobody "fixes" it back.
 *
 * Not to be confused with `maskBanking` in `src/lib/people/people-banking.ts`:
 * that is the SERVER-side policy for one person reading ANOTHER person's record
 * over the wire, it is `server-only`, and it is deliberately not imported here.
 * This rule governs a payee looking at their own already-client-side record.
 */
const BULLET = '•';

/**
 * All but the last four characters replaced with bullets. A value of four
 * characters or fewer becomes all bullets — revealing "the last four" of a
 * four-character value would reveal the whole of it. `null` stays `null`:
 * absent is not the same as hidden, and the caller renders the two differently.
 */
export function maskAccount(value: string | null): string | null {
  if (value == null) return null;
  if (value.length <= 4) return BULLET.repeat(value.length);
  return BULLET.repeat(value.length - 4) + value.slice(-4);
}
