/**
 * Who may NOT file a one-off payment from the People tab — the exclusion half.
 *
 * Kane, 2026-10-02: *"when rob@simple.biz logs in to CEO - People - Should have no Action
 * Column … except for View lets retain that … but the Pay mechanism should be hidden"*.
 * The grant half is the CEO-role `canPay` (2026-09-23) plus the route gate
 * (`requireRateVisibilitySession`). This module is the exclusion: a CEO-role account
 * that keeps every other People capability (browse, View, reveal, export) but never
 * sees or files Pay.
 *
 * Measured 2026-10-02: `ceo` is held by rob@, carla@ and accounting@simple.biz, and
 * nothing in the roles or grants separates rob@ from the other two, so the rule cannot
 * be expressed as a role and has to name him. rob@ has no Global Master List row, so
 * there are no alternate work emails to sign in through. Same shape as
 * `time-adjustment-deciders.ts`: a code constant, reviewed in git, tested, and applied
 * identically on the server (refusal) and in the UI (Pay hidden on roster, popup and
 * Offboarded). Edit here.
 *
 * Pure and dependency-free so the People client can import it.
 */

export const PAY_ACTION_EXCLUSIONS: readonly string[] = [
  'rob@simple.biz',
];

const EXCLUDED = new Set(PAY_ACTION_EXCLUSIONS.map((e) => e.trim().toLowerCase()));

/** True when this account must not see or file the People tab's Pay action. */
export function isExcludedFromPayAction(email: string | null | undefined): boolean {
  const e = (email ?? '').trim().toLowerCase();
  return !!e && EXCLUDED.has(e);
}

/** Starts with "Not authorized" so the route answers 403. */
export const EXCLUDED_PAY_ERROR =
  'Not authorized — your account is excluded from filing one-off payments';
