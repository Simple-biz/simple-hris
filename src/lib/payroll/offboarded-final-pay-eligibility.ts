/**
 * Whether an offboard reason represents someone who's actually leaving.
 *
 * `temporary_pause` suspends the Workspace account for an approved leave —
 * the person is expected back via the normal re-onboard flow (see
 * `src/lib/hr/offboard-reasons.ts`), so there is no "final pay" to set up for
 * them. Showing them in a final-pay review list would be actively misleading:
 * a clerk could set a "final" bank/rate for someone who's still employed.
 *
 * Pure — no I/O — so node:test can exercise every branch.
 */
export function isEligibleForFinalPayReview(reason: string | null): boolean {
  return reason !== 'temporary_pause';
}
