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

/** The one gate both triggers ask. True only for a week that owes nothing and
 *  actually paid somebody — an empty cycle (0 paid, 0 owed) is not a victory. */
export function isCycleFullyPaid(s: CycleSettlement): boolean {
  return payableUnpaidCount(s) === 0 && s.paidCount > 0;
}
