/**
 * State of the Dispatch step's primary button — "Lock in Values & Send to
 * Payment Dispatch" — resolved from the gates the step already honours, in
 * one place, so the label and the `disabled` flag can never disagree.
 *
 * Precedence (first match wins):
 *   1. `dispatching`  — a stage POST is in flight (red running light).
 *   2. `replay`       — a past period is view-only.
 *   3. `lockLoading`  — the per-cycle lock flag has not hydrated yet; until we
 *                       KNOW the cycle is unlocked the button stays off, so a
 *                       fast click cannot re-stage an already-locked cycle.
 *   4. `locked`       — the cycle is already locked and sent. The button is
 *                       greyed out: a re-lock upserts money columns onto rows
 *                       that may already be PAID (paystub-staged-snapshot-stale),
 *                       and every governing doc names "unlock and re-lock" — via
 *                       the Unlock button — as the only sanctioned re-stage path.
 *   5. `fxMissing`    — either cycle FX rate is 0 (payroll-readiness.md hard gate).
 *   6. `ready`.
 *
 * `reason` is stable so the JSX can key copy and styling off it; `label` is the
 * button text the operator actually reads.
 */
export type DispatchButtonReason =
  | 'dispatching'
  | 'replay'
  | 'lock-loading'
  | 'locked'
  | 'fx-missing'
  | 'ready';

export interface DispatchButtonInput {
  isDispatching: boolean;
  isReplay: boolean;
  /** `useWizardDispatchLock(...).loading` */
  lockLoading: boolean;
  /** `useWizardDispatchLock(...).state.locked` */
  locked: boolean;
  usdToPhpRate: number;
  usdToCopRate: number;
}

export interface DispatchButtonState {
  disabled: boolean;
  label: string;
  reason: DispatchButtonReason;
}

export const DISPATCH_BUTTON_READY_LABEL = 'Lock in Values & Send to Payment Dispatch';
export const DISPATCH_BUTTON_LOCKED_LABEL = 'Locked in & sent to Payment Dispatch';

export function resolveDispatchButtonState(input: DispatchButtonInput): DispatchButtonState {
  if (input.isDispatching) {
    return { disabled: true, label: 'Sending to Dispatch…', reason: 'dispatching' };
  }
  if (input.isReplay) {
    return { disabled: true, label: 'View-only (past period)', reason: 'replay' };
  }
  if (input.lockLoading) {
    return { disabled: true, label: 'Checking lock status…', reason: 'lock-loading' };
  }
  if (input.locked) {
    return { disabled: true, label: DISPATCH_BUTTON_LOCKED_LABEL, reason: 'locked' };
  }
  if (!(input.usdToPhpRate > 0) || !(input.usdToCopRate > 0)) {
    return { disabled: true, label: 'Set Step 2 rates first', reason: 'fx-missing' };
  }
  return { disabled: false, label: DISPATCH_BUTTON_READY_LABEL, reason: 'ready' };
}

/**
 * "Sep 3, 4:12 PM" for the locked banner; `null` when the stamp is absent or
 * unparseable (legacy `'true'` flags carry no timestamp) so the caller can drop
 * the clause instead of printing "Invalid Date".
 */
export function formatLockedStamp(iso: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date}, ${time}`;
}
