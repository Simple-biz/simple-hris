/**
 * When may the "payment cycle 100% complete" celebration fire?
 *
 * Pure decision logic for the `payment_cycle_complete` webhook, split out of
 * Payment Dispatch (like `readiness-celebration.ts`) because there are now TWO
 * trigger points and they must ask the same question:
 *
 *   1. The Dispatch Progress strip reaching 100% on its own, while the screen
 *      is open (`payment-dispatch.md` §12.7).
 *   2. Closing the pay cycle from the Stop dialog (`cycle-closeout.md`) — added
 *      2026-08-14, because trigger 1 is missable: it needs a browser open at the
 *      moment the last payment lands AND the webhook already configured.
 *
 * The rule is the strip's own denominator: a cycle is finished only when NOBODY
 * PAYABLE IS UNPAID — nothing pending, nobody parked on Problem, nobody held at
 * Threshold — and at least one person was actually paid. Problem and Threshold
 * people are money still owed, so a week carrying one has not finished paying
 * and the congratulations would be a lie. People on the **Excluded** tab are not
 * payable at all (Kane's rule) and never enter these counts.
 *
 * `cycleStartedCount` is the same total the strip shows, and keeping it here is
 * what makes the API contract structural rather than coincidental: the route
 * (`/api/payment-dispatches/cycle-complete`) rejects any body whose `paid_count`
 * and `total_count` differ, and a body built from these two functions can only
 * satisfy that when `isCycleFullyPaid` is true. A test pins the equivalence.
 *
 * No I/O, no framework — the caller owns the fetch, the once-per-mount noise
 * control, and the past-week rule.
 */

/** The four buckets every payee in a cycle falls into, as counts. Sourced from
 *  the SAME memo that feeds the progress strip, so this can never disagree with
 *  the number on screen. */
export interface CycleSettlement {
  /** Still in the pending queue — never dispatched. */
  pendingCount: number;
  /** Logged Problem: out of the queue, money stuck. */
  blockedCount: number;
  /** Logged Threshold: deliberately held under the payout minimum. */
  heldCount: number;
  /** Distinct payees actually paid (superseded markers already collapsed). */
  paidCount: number;
}

/** People this cycle owes money to. The close-out record's `unpaid` list is the
 *  named version of exactly this set. */
export function payableUnpaidCount(s: CycleSettlement): number {
  return s.pendingCount + s.blockedCount + s.heldCount;
}

/** What the week began with: everyone paid plus everyone still owed. Grows or
 *  shrinks only if the queue itself does. */
export function cycleStartedCount(s: CycleSettlement): number {
  return s.paidCount + payableUnpaidCount(s);
}

/** True only for a week that owes nothing and actually paid somebody — an empty
 *  cycle (0 paid, 0 owed) is not a victory. This is what the STRIP trigger means
 *  by "100%", and it still gates that trigger exactly as before. Since
 *  2026-08-14 it no longer gates the CLOSE trigger — see `CycleCompleteTrigger`. */
export function isCycleFullyPaid(s: CycleSettlement): boolean {
  return payableUnpaidCount(s) === 0 && s.paidCount > 0;
}

/**
 * WHY a completion is being reported. Two events, two different truth claims —
 * kept as a discriminator rather than one loosened numeric rule, so neither arm
 * has to weaken to let the other through.
 *
 *  - `fully_paid`   — the progress strip genuinely reached 100%. Requires
 *                     `paid === total`, exactly as it always has.
 *  - `cycle_closed` — Accounting CLOSED the week (Kane, 2026-08-14: "if it's
 *                     closed it's closed"). A shortfall is legitimate here and
 *                     is reported honestly as `unpaid_count`, never hidden by
 *                     inflating `paid_count` to match `total_count`.
 */
export type CycleCompleteTrigger = 'fully_paid' | 'cycle_closed';

export const CYCLE_COMPLETE_TRIGGERS: readonly CycleCompleteTrigger[] = [
  'fully_paid',
  'cycle_closed',
];

export function asCycleCompleteTrigger(v: unknown): CycleCompleteTrigger {
  // Unknown/missing reads as the STRICTER arm: an unlabelled report must not
  // inherit the close's permission to carry a shortfall.
  return v === 'cycle_closed' ? 'cycle_closed' : 'fully_paid';
}

/**
 * The server-side boundary check, shared with the client so the two can't
 * disagree about what is sendable. Per-arm strict:
 *
 *   - nothing paid at all is never reportable, on either arm — a "congratulations"
 *     naming zero payees is a bug, not a policy;
 *   - `total < paid` is a broken report on either arm (more people paid than the
 *     cycle ever had);
 *   - `fully_paid` additionally demands equality.
 */
export function isReportableCycleComplete(input: {
  trigger: CycleCompleteTrigger;
  paidCount: number;
  totalCount: number;
}): boolean {
  const { trigger, paidCount, totalCount } = input;
  if (!Number.isFinite(paidCount) || !Number.isFinite(totalCount)) return false;
  if (paidCount <= 0 || totalCount < paidCount) return false;
  return trigger === 'cycle_closed' ? true : paidCount === totalCount;
}

/**
 * The once-per-cycle-EVER claim key. `app_settings.key` is unique, so the route
 * INSERTs this before mailing and any later trigger hitting `23505` stays
 * silent. It is released ONLY when the webhook delivery itself failed.
 *
 * Shared deliberately: the route claims it, and `reopenCycle` BURNS it (inserts
 * it unsent) so a reopened week can never celebrate again. Two spellings of this
 * string would be two different guarantees, so there is exactly one.
 */
export const CYCLE_COMPLETE_NOTIFIED_PREFIX = 'dispatch.cycle_complete_notified.';

export function cycleCompleteNotifiedKey(sourceFile: string): string {
  return `${CYCLE_COMPLETE_NOTIFIED_PREFIX}${sourceFile}`;
}
