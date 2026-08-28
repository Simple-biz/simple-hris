// Whether a MESA disbursement may be drawn at all.
//
// Until now there was NO such check anywhere. `POST /api/mesa-requests` stored
// `amount_needed` exactly as sent — no type check, no sign check, no balance
// check — so a member could request any sum against any balance, and the only
// thing standing between an over-balance draw and approval was a reviewer
// noticing a coloured panel in the Review modal. Live example, 2026-08-27:
// kaner@ had a pending PHP 5,000 disbursement against a PHP 3,600 balance.
//
// This module is the arithmetic only. It is browser-safe on purpose — the
// employee form and the API import the SAME function, so what the form tells
// someone is available is exactly what the server will enforce. Two
// implementations of "available" would eventually disagree, and the member
// would be refused a draw the screen had just offered them.
//
// The rule that is easy to get wrong is OUTSTANDING. A member's ledger balance
// is not what they can draw: requests that are pending, or approved but not yet
// dispatched, have not left the fund yet and so are invisible to the ledger
// (docs/features/mesa.md:66 — the Review modal flags them "rather than
// subtracted"). That is fine for a display but wrong for a guard: with PHP
// 3,600 and two separate PHP 2,000 requests, each passes on its own and
// together they overdraw by PHP 400. Available subtracts them.

/** A request already competing for the same funds. */
export interface OutstandingDisbursement {
  request_type: string | null;
  status: string | null;
  amount_needed: number | null;
  /**
   * Set once the money has actually been sent — at which point it IS in the
   * ledger, and counting it here would subtract it twice.
   *
   * `undefined` is accepted because a caller may pass rows from a select that
   * omitted the column. That direction is SAFE: an unknown dispatch state is
   * treated as not-yet-dispatched, so the draw is still counted against the
   * balance and the member is held to a STRICTER limit, never a looser one.
   */
  dispatched_at?: string | null;
}

export type DisbursementRefusal =
  | 'invalid_amount'
  | 'exceeds_available';

export interface DisbursementCheck {
  ok: boolean;
  reason?: DisbursementRefusal;
  /** What was asked for, after coercion. NaN-safe: 0 when unusable. */
  requested: number;
  /** Ledger balance of the member's open account. */
  balance: number;
  /** Sum of not-yet-dispatched draws already in flight. */
  outstanding: number;
  /** balance − outstanding, floored at 0. */
  available: number;
  /** How far over the line, 0 when within it. */
  shortfall: number;
  /** Ready to show a member or return in an API error. */
  message: string | null;
}

const money = (n: number): string =>
  `PHP ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Round to centavos. Float sums of money drift, and a drift of 0.0000001
 *  would refuse a draw for exactly the balance. */
const cents = (n: number): number => Math.round(n * 100) / 100;

/**
 * Sum the draws already competing for these funds: `disbursement` rows that are
 * pending, or approved but NOT yet dispatched.
 *
 * Denied rows released nothing and are ignored. Dispatched rows are excluded
 * because the money has left and the ledger already reflects it — counting them
 * would subtract the same peso twice.
 */
export function sumOutstandingDisbursements(
  rows: readonly OutstandingDisbursement[] | null | undefined,
): number {
  if (!rows?.length) return 0;
  let total = 0;
  for (const r of rows) {
    if (r.request_type !== 'disbursement') continue;
    if (r.dispatched_at) continue;
    const status = (r.status ?? '').toLowerCase();
    if (status !== 'pending' && status !== 'approved') continue;
    const amt = typeof r.amount_needed === 'number' ? r.amount_needed : 0;
    if (Number.isFinite(amt) && amt > 0) total += amt;
  }
  return cents(total);
}

/**
 * The whole decision. Pure, so every failure class below is locked by a test
 * rather than asserted:
 *
 *   - a non-number / NaN / Infinity amount          -> invalid_amount
 *   - zero or negative                              -> invalid_amount
 *   - more than balance                             -> exceeds_available
 *   - within balance but not once outstanding
 *     draws are subtracted                          -> exceeds_available
 *   - EXACTLY the available amount                  -> allowed (not an off-by-one)
 */
export function checkDisbursementAmount(input: {
  requested: unknown;
  balance: number;
  outstanding?: number;
}): DisbursementCheck {
  const balance = cents(Number.isFinite(input.balance) ? input.balance : 0);
  const outstanding = cents(
    Number.isFinite(input.outstanding ?? 0) ? (input.outstanding ?? 0) : 0,
  );
  const available = cents(Math.max(0, balance - outstanding));

  const raw = typeof input.requested === 'number' ? input.requested : Number(input.requested);
  if (!Number.isFinite(raw) || raw <= 0) {
    return {
      ok: false,
      reason: 'invalid_amount',
      requested: 0,
      balance,
      outstanding,
      available,
      shortfall: 0,
      message: 'Enter an amount greater than zero.',
    };
  }

  const requested = cents(raw);
  if (requested > available) {
    const shortfall = cents(requested - available);
    return {
      ok: false,
      reason: 'exceeds_available',
      requested,
      balance,
      outstanding,
      available,
      shortfall,
      message:
        outstanding > 0
          ? `That is ${money(shortfall)} more than you can draw. Your balance is ${money(balance)}, but ${money(outstanding)} is already committed to a request awaiting payout, leaving ${money(available)}.`
          : `That is ${money(shortfall)} more than your balance of ${money(available)}.`,
    };
  }

  return {
    ok: true,
    requested,
    balance,
    outstanding,
    available,
    shortfall: 0,
    message: null,
  };
}
