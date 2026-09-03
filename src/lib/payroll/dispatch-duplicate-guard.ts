/**
 * Server-side "already paid this cycle" guard for `POST /api/payment-dispatches`.
 *
 * Until 2026-09-03 the only thing stopping a person from being marked paid twice
 * in one cycle was the dispatch queue's client-side filter. A stale queue reload
 * (a slower earlier load landing after the optimistic removal) painted a
 * just-paid person back into Pending, the clerk marked them again, and the
 * server wrote a second `paid` row — 82 doubled people across five cycles,
 * ₱992,843 of phantom "paid" money in the log, and one pair with two different
 * processor transaction ids (a possible real double payment).
 *
 * The rules, each pinned in dispatch-duplicate-guard.test.ts:
 *  - Only a second **`paid`** row is a duplicate. `not_paid` / `threshold` /
 *    `problem` are log entries that deliberately leave the person payable
 *    (payment-dispatch.md §3.5), so they never block and are never blocked.
 *  - **Employee rows only.** A contractor settlement is guarded by the invoice
 *    claim in the route (one invoice → one paid row) and may legitimately share
 *    an email with that person's salary row.
 *  - The cycle is identified by **`cycle_source_file` first**: the arrears
 *    "Settle" path POSTs one leg per held cycle with `cycle_id: null`
 *    (payment-dispatch.md §3.7), so keying on `cycle_id` alone would let those
 *    legs slip through. `cycle_id` is the fallback when no file is named.
 *  - A body naming neither a source file nor a cycle id cannot be checked and is
 *    not blocked — nothing in the app sends one, and inventing a cycle would be
 *    worse than the pre-guard behaviour.
 */

export const ALREADY_PAID_CODE = 'already_paid' as const;

export interface DuplicateGuardInput {
  /** `undefined` means the route default, `paid`. */
  status: string | null | undefined;
  payeeType: 'employee' | 'contractor';
  recipientEmail: string;
  cycleSourceFile: string | null | undefined;
  cycleId: string | null | undefined;
}

/** The slice of a `payment_dispatches` row the guard needs. */
export interface PriorDispatch {
  id: string;
  status: string;
  /** Absent on rows written before the contractor migration → employee. */
  payee_type?: string | null;
  recipient_email: string;
  cycle_source_file: string | null;
  cycle_id: string | null;
  created_by: string | null;
  created_at: string;
  transaction_id: string;
}

const normEmail = (e: string) => e.trim().toLowerCase();
const normFile = (f: string | null | undefined) => (f ?? '').trim() || null;

/** Whether this POST is the kind the guard must check at all. */
export function duplicateGuardApplies(input: DuplicateGuardInput): boolean {
  if ((input.status ?? 'paid') !== 'paid') return false;
  if (input.payeeType !== 'employee') return false;
  if (!normEmail(input.recipientEmail)) return false;
  return normFile(input.cycleSourceFile) !== null || Boolean(input.cycleId);
}

/** Same pay cycle as the incoming body — source file first, cycle id fallback. */
export function sameDispatchCycle(
  prior: Pick<PriorDispatch, 'cycle_source_file' | 'cycle_id'>,
  input: Pick<DuplicateGuardInput, 'cycleSourceFile' | 'cycleId'>,
): boolean {
  const file = normFile(input.cycleSourceFile);
  if (file !== null) return normFile(prior.cycle_source_file) === file;
  return Boolean(input.cycleId) && prior.cycle_id === input.cycleId;
}

/**
 * The earliest existing `paid` employee row for this person in this cycle, or
 * null when the payment is genuinely new. Oldest wins because that row marks
 * the moment the money actually moved; anything later is the echo.
 */
export function findDuplicatePaid(
  input: DuplicateGuardInput,
  prior: readonly PriorDispatch[],
): PriorDispatch | null {
  if (!duplicateGuardApplies(input)) return null;
  const email = normEmail(input.recipientEmail);
  const matches = prior.filter(
    (p) =>
      p.status === 'paid' &&
      (p.payee_type ?? 'employee') === 'employee' &&
      normEmail(p.recipient_email) === email &&
      sameDispatchCycle(p, input),
  );
  if (matches.length === 0) return null;
  return matches.reduce((oldest, p) => (p.created_at < oldest.created_at ? p : oldest));
}

/** Clerk-facing 409 message. Names who logged the first payment and when. */
export function alreadyPaidMessage(dup: PriorDispatch): string {
  const when = dup.created_at.replace('T', ' ').slice(0, 16) + ' UTC';
  const who = dup.created_by ?? 'someone';
  const txn = dup.transaction_id ? ` (txn ${dup.transaction_id})` : '';
  return `Already marked paid this cycle by ${who} at ${when}${txn}. No second payment was logged — refresh the queue.`;
}
