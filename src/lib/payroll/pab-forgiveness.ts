/**
 * When an approved PAB issue (`pab_day_disputes`) forgives its day — the ONE rule every
 * PAB verdict and calendar reads. Pure and client-safe.
 *
 * ## The rule (Kane, 2026-10-06 — session log item 363, ruling "(b)")
 *
 * - `override_hours` **null** → the day is **forgiven outright**, whatever was tracked.
 *   It keeps its original hours (nothing is added) and counts as a passing day. This is
 *   what both Payroll Wizard forgive paths, the Attendance Issues panel and an Issues-queue
 *   approval with the hours left blank all write, and what orphanage-style rows always
 *   carry.
 * - a **number** → an explicit hours SET that replaces Hubstaff for the day. It forgives at
 *   ≥ 4h (bumped to a full pass); below 4h the approver has said the day failed, and `0` is
 *   the intentional zero-out.
 *
 * Before 2026-10-06, `null` meant a **4h floor** for every non-orphanage reason: a forgiven
 * 0–3h day stayed failed. That floor was a sanity check on EMPLOYEE-filed forgiveness of
 * no-show days, and employees have not been able to file since 2026-07-20, so every
 * approval is Accounting's own decision. The floor also contradicted the documented
 * orphanage-visit bypass: the employee calendars skipped it for orphanage rows while
 * `applyPabAdjustments` and the wizard (reason-blind) did not, so a 0–3h visit day read
 * "Forgiven" on a calendar whose own verdict — and dispatch — failed it.
 *
 * Callers must check that an issue EXISTS for the day first; `undefined` ("no entry") is
 * deliberately not accepted, so it can never be confused with `null` ("no hours set").
 */

/** An explicit hours SET forgives its day only at or above this. */
export const PAB_SET_HOURS_FLOOR = 4;

export function approvedIssueForgivesDay(overrideHours: number | null): boolean {
  return overrideHours === null || overrideHours >= PAB_SET_HOURS_FLOOR;
}
