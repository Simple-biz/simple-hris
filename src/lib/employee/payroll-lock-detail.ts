/**
 * What the employee shell's "Payroll is being processed" banner says BELOW the
 * headline, for the tab the person is actually looking at.
 *
 * The banner is mounted once at the top of the shell and sits above EVERY tab.
 * Its sentence was the fixed string *"Issues are temporarily paused."* — and
 * the Issues tab has since been removed from the employee shell (the nav entry
 * at `EmployeeSidebar.tsx` and the render branch in `EmployeeApp.tsx` are both
 * commented out). So during every payroll run, every employee on every tab read
 * a red bar announcing the pause of a feature they could not see, which reads
 * as *"the whole dashboard is frozen"*.
 *
 * That cost real work. Kane, 2026-09-16: *"while Payroll is processing we
 * should still be able to create Termination Letters and COE's ... we dont want
 * to delay Documents."* Nothing was ever gating Documents
 * (`src/lib/documents/documents-unaffected-by-payroll-lock.test.ts` pins it) —
 * the banner alone was the delay, because people believed it.
 *
 * The rule this module encodes: **the banner states the consequence for the tab
 * in view, and never a consequence that is not real there.** Exactly one
 * employee surface changes under the lock — the Payment/payout section on
 * Profile, whose bank fields go read-only (`EmployeeProfile.tsx`, the
 * `payrollLocked` prop). Everywhere else the honest sentence says so, because
 * silence on a red bar is read as a lock.
 *
 * Kept as a pure module because tests never execute `.tsx`.
 */

/**
 * The one employee shell tab with a real consequence under the payroll lock.
 * Profile hosts BOTH the locked payout section and the unaffected Documents
 * tab, which is precisely why its sentence has to name both.
 */
export const PAYROLL_LOCK_AFFECTED_TABS: readonly string[] = ['profile'];

/** Said on Profile — one true restriction, and the reassurance that matters. */
export const PAYROLL_LOCK_DETAIL_PROFILE =
  'Your payment details are read-only until it finishes. Requesting documents is unaffected.';

/** Said everywhere else. A red bar with no consequence named reads as a lock. */
export const PAYROLL_LOCK_DETAIL_UNAFFECTED = 'Nothing on this page is affected.';

/**
 * The banner's sentence for `tab`.
 *
 * Unknown tabs — a newly added one, or a key this module has not been taught —
 * fall to the UNAFFECTED sentence deliberately. That is not a fallback masking
 * a gap: no employee surface but the payout section is gated, so "unaffected"
 * is the TRUE statement for anything new, and a wrong reassurance here cannot
 * block anyone (it can only fail to warn about a restriction that, by the
 * source scan above, does not exist). If a second surface is ever genuinely
 * locked, it gets added to `PAYROLL_LOCK_AFFECTED_TABS` and its own sentence —
 * and the test below fails until it does.
 */
export function payrollLockDetailFor(tab: string): string {
  return PAYROLL_LOCK_AFFECTED_TABS.includes(tab)
    ? PAYROLL_LOCK_DETAIL_PROFILE
    : PAYROLL_LOCK_DETAIL_UNAFFECTED;
}
