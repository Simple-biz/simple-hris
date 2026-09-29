/**
 * Who may change a tenure-gift record, and which way it may move.
 *
 * Carla, 2026-09-29, looking at a person's Milestone history:
 *   "if 'received' 'Not yet' should disappear. 'clear' can stay"
 *   "I hate how easy it is to undo … you can just undo yourself every month and
 *    get a new shirt"
 *
 * So, shared by the Gift Tracker buttons and the route that enforces them:
 *
 *  - RECEIVED IS NOT FLIPPED TO OWED IN ONE STEP. A received gift offers only
 *    Clear, and the server refuses `received: false` over a received row. The
 *    only way back is Clear, which now needs a written reason.
 *  - NOBODY RECORDS OR CLEARS THEIR OWN GIFT. Staff with Gift Tracker edit are
 *    employees too; a statement about what the company owes you is not yours to
 *    make (the same reason the employee card can never write).
 *  - RE-STATING THE CURRENT STATE WRITES NOTHING. An upsert would re-stamp
 *    `source`/`recorded_by`/`recorded_at` and turn a sheet-imported row into an
 *    'hris' one, erasing where the statement came from.
 *
 * Governing doc: docs/features/gift-tracker-receipts.md § Recording fulfilment.
 */
import type { GiftReceiptState } from './receipts';

/** Which of the three statements a milestone offers in its current state. */
export interface ReceiptActions {
  received: boolean;
  notYet: boolean;
  clear: boolean;
}

/**
 * The buttons a milestone shows. The button for the CURRENT state is never
 * shown (the chip already says it), and a received gift offers only Clear.
 *
 *   unknown   Received · Not yet
 *   owed      Received · Clear      (owed → received is the fulfilment path;
 *                                    forcing a Clear first would write "we
 *                                    should not have said anything" about a
 *                                    debt that was real)
 *   received  Clear
 *   not_due   Received              (an early receipt is a stated fact; nothing
 *                                    can be owed before it is due)
 */
export function receiptActionsFor(state: GiftReceiptState): ReceiptActions {
  switch (state) {
    case 'unknown':
      return { received: true, notYet: true, clear: false };
    case 'owed':
      return { received: true, notYet: false, clear: true };
    case 'received':
      return { received: false, notYet: false, clear: true };
    case 'not_due':
      return { received: true, notYet: false, clear: false };
  }
}

export type ReceiptWriteDecision =
  | { kind: 'write' }
  | { kind: 'unchanged' }
  | { kind: 'refuse'; reason: 'withdraw_first'; message: string };

/**
 * May a PUT move `current` (undefined = no row) to `requested`?
 *
 * Received → owed is refused: that is the one-click undo. Everything else that
 * changes the state is allowed; re-stating the current state is `unchanged`.
 */
export function decideReceiptWrite(
  current: boolean | undefined,
  requested: boolean,
): ReceiptWriteDecision {
  if (current === requested) return { kind: 'unchanged' };
  if (current === true && requested === false) {
    return {
      kind: 'refuse',
      reason: 'withdraw_first',
      message:
        'This gift is recorded as received. Clear it first (with a reason) before recording it as not given.',
    };
  }
  return { kind: 'write' };
}

/**
 * Is `targetWorkEmail` one of the actor's own addresses? `own` is every address
 * the actor is known by (session, master row work/personal/alternates, aliases).
 * Exact, case-insensitive; a blank target is never "own".
 */
export function isOwnGiftRecord(targetWorkEmail: string, own: readonly string[]): boolean {
  const target = targetWorkEmail.trim().toLowerCase();
  if (!target) return false;
  return own.some((e) => e.trim().toLowerCase() === target);
}

export const OWN_GIFT_MESSAGE =
  'You cannot record or clear your own gift. Ask someone else on the Gift Tracker to do it.';

/** Shortest reason a Clear accepts. Long enough to rule out "x" and "undo". */
export const MIN_WITHDRAW_REASON = 8;
export const MAX_WITHDRAW_REASON = 500;

/**
 * Validate a Clear's reason. Required — withdrawing a statement destroys the row,
 * and "why" is the one thing the audit entry cannot reconstruct afterwards.
 */
export function readWithdrawReason(raw: unknown): { reason: string } | { error: string } {
  const reason = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (reason.length < MIN_WITHDRAW_REASON) {
    return { error: `A reason is required to clear a gift record (at least ${MIN_WITHDRAW_REASON} characters).` };
  }
  if (reason.length > MAX_WITHDRAW_REASON) {
    return { error: `Keep the reason under ${MAX_WITHDRAW_REASON} characters.` };
  }
  return { reason };
}
