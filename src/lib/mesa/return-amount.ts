// The amount on a MESA `return` request: what the member is putting back into
// their account (tickets board, 2026-10-05 — "Returns must show the Mesa amount
// being added back to the account"). Before this a return carried no amount at
// all, so the Review modal could only show the balance (docs/features/mesa.md).
//
// Browser-safe: the employee form and POST /api/mesa-requests import the SAME
// check, so the form can never accept an amount the server then refuses.
//
// A return is an inflow, so it is not judged against the balance. It is not
// capped at what the member has drawn either — nothing documents such a rule;
// the Review modal flags a return larger than the account's draws instead.

/** numeric(12,2) holds 10 integer digits; the form allows 9, as for a disbursement. */
export const MAX_MESA_RETURN_PHP = 999_999_999.99;

export type ReturnAmountCheck =
  | { ok: true; amount: number }
  | { ok: false; message: string };

export function checkReturnAmount(requested: unknown): ReturnAmountCheck {
  // Only a number or a numeric string is an amount — Number(true) is 1. Number('')
  // is 0, so a blank field lands in the same refusal as a zero or negative one.
  const raw =
    typeof requested === 'number' ? requested : typeof requested === 'string' ? Number(requested.trim()) : NaN;
  const amount = Number.isFinite(raw) ? Math.round(raw * 100) / 100 : 0;
  if (amount <= 0) {
    return { ok: false, message: 'Enter the amount you are returning — more than zero.' };
  }
  if (amount > MAX_MESA_RETURN_PHP) {
    return { ok: false, message: 'That amount is too large.' };
  }
  return { ok: true, amount };
}
