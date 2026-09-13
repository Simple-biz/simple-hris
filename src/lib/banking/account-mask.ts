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
 * **The bullets count CHARACTERS; the "too short to reveal" floor counts
 * DIGITS.** The two halves deliberately measure different things, and getting
 * that wrong is a disclosure bug, not a cosmetic one.
 *
 * - The mask is as long as the stored value, separators included, because the
 *   account number is never reformatted anywhere on this card — no 4-4-4-4
 *   grouping, leading zeros preserved (see the header comment in bank-card.tsx).
 *   The local rule this replaced stripped `-` and spaces before counting, so a
 *   stored `1234-5678-9012` masked down to a 12-character string that no longer
 *   described the 14-character value underneath it.
 * - The floor, however, still strips. It has to: it is what stops a SHORT value
 *   being partly revealed, and shortness is a property of the digits, not of the
 *   punctuation between them.
 *
 * **This floor is load-bearing — do not "simplify" it to `value.length <= 4`.**
 * That version was written, shipped to review, and falsified there by running
 * both rules side by side:
 *
 * | stored    | correct  | floor removed | leak                  |
 * |-----------|----------|---------------|-----------------------|
 * | `" 1234"` | `•••••`  | `•1234`       | **the entire value**  |
 * | `"12-34"` | `•••••`  | `•2-34`       | `234`                 |
 * | `"1234 "` | `•••••`  | `•234 `       | `234`                 |
 * | `"1 2 3 4"`| `•••••••`| `••• 3 4`    | `34`                  |
 *
 * Any value whose stripped length is ≤ 4 but whose raw length is > 4 falls
 * straight past a raw-length floor into the reveal branch. `account-mask.test.ts`
 * pins all four rows, and pins the general property differentially against the
 * rule this replaced rather than asserting it in prose.
 *
 * With the floor in place the rule reveals a subset of what the old one did, on
 * every input: the four characters it shows are a suffix of the four the old one
 * showed, and a separator among them means fewer digits, never more.
 *
 * Not to be confused with `maskBanking` in `src/lib/people/people-banking.ts`:
 * that is the SERVER-side policy for one person reading ANOTHER person's record
 * over the wire, it is `server-only`, and it is deliberately not imported here.
 * This rule governs a payee looking at their own already-client-side record.
 */
const BULLET = '•';

/**
 * All but the last four characters replaced with bullets.
 *
 * A value carrying four or fewer actual characters — ignoring hyphens and
 * spaces — becomes ALL bullets: revealing "the last four" of a four-digit value
 * would reveal the whole of it, and a separator must never be able to pad a
 * short value past that check.
 *
 * `null` stays `null`: absent is not the same as hidden, and the callers render
 * the two differently.
 */
export function maskAccount(value: string | null): string | null {
  if (value == null) return null;
  // Strip for the FLOOR only — never for the bullet count below it.
  if (value.replace(/[-\s]/g, '').length <= 4) return BULLET.repeat(value.length);
  return BULLET.repeat(value.length - 4) + value.slice(-4);
}
