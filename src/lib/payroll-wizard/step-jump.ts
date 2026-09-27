/**
 * "Go to Step N" from outside the Payroll Wizard — the pure rule for whether a
 * jump request is honoured and what it does. Used by `PayrollWizard`'s
 * `jumpRequest` effect; the request comes from the Accounting dashboard's
 * greeting modal (Kane, 2026-09-26).
 *
 * A jump has EXACTLY the power of a click on the wizard's own step rail, never
 * more:
 *  - it is refused while this viewer is spectating another operator's
 *    processing run — the rail is behind the spectator overlay then, and the
 *    follow channel would snap the step straight back anyway;
 *  - it may switch the wizard's cycle only BACK to the live period (the newest
 *    upload), the same move as the replay banner's "Return to current period"
 *    — never INTO a replay, even if the request names an older file;
 *  - step 4 (PAB) exists on the rail only during the payout week; a request for
 *    it outside that week lands on 5, the step the rail's Next skips to.
 * The view-only lock (`ReadOnlyTab strict`) is enforced by the CALLER: the
 * modal offers no jump to a viewer without the wizard's edit grant.
 */

/** What the shell hands the wizard. `nonce` makes two requests for the same
 *  step distinct, so a second click after navigating away still lands. */
export interface WizardJumpRequest {
  step: number;
  sourceFile: string | null;
  nonce: number;
}

export interface WizardJumpInput {
  requestedStep: number;
  /** The upload the requester was describing; null = leave the cycle alone. */
  requestedFile: string | null;
  calcSourceFile: string | null;
  newestSourceFile: string | null;
  isSpectator: boolean;
  pabPayoutWeekActive: boolean;
  /** Steps on the rail (ids are contiguous 1..stepCount). */
  stepCount: number;
}

export type WizardJumpPlan =
  | { kind: 'refused'; reason: 'spectating' | 'invalid-step' }
  | { kind: 'go'; step: number; switchToFile: string | null };

export const PAB_STEP_ID = 4;

export function planWizardJump(input: WizardJumpInput): WizardJumpPlan {
  if (input.isSpectator) return { kind: 'refused', reason: 'spectating' };
  const s = input.requestedStep;
  if (!Number.isInteger(s) || s < 1 || s > input.stepCount) return { kind: 'refused', reason: 'invalid-step' };
  const step = s === PAB_STEP_ID && !input.pabPayoutWeekActive ? PAB_STEP_ID + 1 : s;
  const switchToFile =
    input.requestedFile != null &&
    input.newestSourceFile != null &&
    input.requestedFile === input.newestSourceFile &&
    input.calcSourceFile !== input.requestedFile
      ? input.requestedFile
      : null;
  return { kind: 'go', step, switchToFile };
}
