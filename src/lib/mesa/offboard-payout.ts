// Releasing a MESA balance when a member leaves the program.
//
// THE BUG THIS CLOSES
// -------------------
// Closing a MESA account "zeroes" it — every balance in the app aggregates
// ledger events on/after the OPEN account's opened_on, so once closed_on is
// stamped the member's figures read PHP 0. That is correct for a re-join
// (a fresh account starts empty) but it was ALSO what happened on an opt-out,
// where the member is owed the money. Approving an opt-out marked the request
// approved, set mesa_member = false, closed the account — and moved nothing.
// The balance simply stopped being displayed.
//
// Measured on production 2026-08-28: two pending opt-outs carrying PHP 5,200
// (kristinec@ 3,600 and angeld@ 1,600) would have been zeroed on approval, and
// five already-offboarded people were owed PHP 37,600 that nothing surfaced.
//
// THE RULE (Aliviah, 2026-08-28)
// ------------------------------
// "Their balance wouldn't change based on their reason for leaving. If they
// were participating in the program until they left, they would be owed that
// balance. BUT it can only be released if they fill out an opt-out request —
// usually completed by April manually because the worker is offboarded by
// that point."
//
// So the opt-out request is the AUTHORIZATION, and closing the account is the
// moment the debt becomes real. The reason for leaving is deliberately not an
// input: a resignation and a policy-violation termination release identically.
//
// WHY NO LEDGER ROW IS WRITTEN HERE
// ---------------------------------
// A disbursement row in `mesa_ledger` means money LEFT THE FUND. At opt-out it
// has not: it has been promised. Writing one now would make the ledger claim a
// payout that may not happen for weeks. Closing the account already hides the
// balance from every display, so the obligation alone is the honest record —
// and unlike the old silent zeroing, it is a row someone can find and pay.
// The ledger row belongs at settlement, when payroll actually moves the money.

/** The Sun-Sat week model used everywhere in this codebase: a week ends on a
 *  Saturday, and `mesa_payroll_obligations` rejects anything else. */
const SATURDAY = 6;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Round to centavos — float sums of money drift. */
const cents = (n: number): number => Math.round(n * 100) / 100;

export interface MesaPayoutPlan {
  /** The row to insert into mesa_payroll_obligations. */
  obligation: {
    email: string;
    account_number: string | null;
    kind: 'offboard_payout';
    direction: 'credit';
    amount_php: number;
    due_week_end: string;
    notes: string;
  };
}

/**
 * The first Saturday STRICTLY AFTER `iso` — the week whose paycheck settles a
 * balance released today.
 *
 * Strictly after, not on-or-after: if someone opts out on a Saturday, that
 * week's payroll has already been computed, so its cheque cannot carry a debt
 * raised the same day. Landing it there would look settled while never being
 * paid.
 */
export function nextPayoutWeekEnd(iso: string): string {
  if (!ISO.test(iso)) throw new Error(`date must be YYYY-MM-DD, got ${JSON.stringify(iso)}`);
  const d = new Date(`${iso}T00:00:00Z`);
  const ahead = (SATURDAY - d.getUTCDay() + 7) % 7 || 7;
  return new Date(d.getTime() + ahead * 86_400_000).toISOString().slice(0, 10);
}

/**
 * What to owe someone whose MESA account is being closed on `closingOn`.
 *
 * Returns `null` when there is nothing to release — a zero balance, or an
 * overdrawn one. An overdrawn account is NOT turned into a debt the member
 * owes back: that would invent a claim out of a reconciliation artifact
 * (luckye@'s stint closes PHP 400 overdrawn purely from imported history).
 * It is reported and left alone.
 *
 * A payout is never created for a re-join. The caller decides that: this is
 * only reached when an account is closing, and a re-join OPENS one.
 */
export function planMesaOffboardPayout(input: {
  email: string;
  accountNumber: string | null;
  balance: number;
  closingOn: string;
}): MesaPayoutPlan | null {
  const balance = cents(Number.isFinite(input.balance) ? input.balance : 0);
  if (balance <= 0) return null;

  const email = input.email.trim().toLowerCase();
  if (!email) throw new Error('email is required to release a MESA balance');

  return {
    obligation: {
      email,
      account_number: input.accountNumber,
      kind: 'offboard_payout',
      direction: 'credit',
      amount_php: balance,
      due_week_end: nextPayoutWeekEnd(input.closingOn),
      notes: `MESA balance released on opt-out ${input.closingOn}${
        input.accountNumber ? ` (account ${input.accountNumber})` : ''
      }`,
    },
  };
}
