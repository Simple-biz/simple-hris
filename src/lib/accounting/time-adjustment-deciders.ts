/**
 * Who may decide a time adjustment at the Accounting stage — the exclusion half.
 *
 * Kane, 2026-09-15: *"any one with Acct>Issues>Edit can adjust. (Exclude Jake/April/Lenny)"*.
 * The grant half is the route gate (`requireFeatureEdit('accounting', 'disputes')`)
 * plus the existing `canActOnDisputes` role check. This module is the exclusion: three
 * Accounting Team members who hold (or may later hold) Issues edit for disputes (and,
 * until those rows were retired on 2026-09-24, Bank Preferred work), but must not
 * decide time adjustments.
 *
 * Measured 2026-09-15 (`scripts/probe-time-adjustment-deciders.mts`): no role or grant
 * separates these three from the other Issues editors — jakec@ and april@ hold
 * `accounting` and Issues edit exactly like alyson@ does — so the rule cannot be
 * expressed as a role and has to name them. It is a code constant rather than a
 * setting so it is reviewed in git, tested, and applied identically on the server
 * (refusal) and in the UI (disabled button with the reason). If the list starts
 * changing often it should become an admin-editable setting; until then, edit here.
 *
 * Resolution of the three names against the active roster, for the record:
 *   Jake  → jakec@simple.biz  (Calma, King Gaspar "Jake", Accounting Team)
 *   April → april@simple.biz  (Galang, April Pearl "April", Accounting Team)
 *   Lenny → lenny@simple.biz  (Tesalona, Maria Linda "Lenny", Accounting Team)
 * Other Jakes and Aprils on the roster hold no Accounting grant and are unaffected.
 *
 * Pure and dependency-free so the Issues client can import it.
 */

export const TIME_ADJUSTMENT_DECIDER_EXCLUSIONS: readonly string[] = [
  'jakec@simple.biz',
  'april@simple.biz',
  'lenny@simple.biz',
];

const EXCLUDED = new Set(TIME_ADJUSTMENT_DECIDER_EXCLUSIONS.map((e) => e.trim().toLowerCase()));

/** True when this account must not approve, deny or delete a time adjustment. */
export function isExcludedTimeAdjustmentDecider(email: string | null | undefined): boolean {
  const e = (email ?? '').trim().toLowerCase();
  return !!e && EXCLUDED.has(e);
}

/** Starts with "Not authorized" so the route answers 403, not 400 or 500. */
export const EXCLUDED_DECIDER_ERROR =
  'Not authorized — your account is excluded from deciding time adjustments; another Accounting/Payroll approver must act';

/** The tooltip the disabled button carries — the same sentence, shortened. */
export const EXCLUDED_DECIDER_HINT = 'Your account is excluded from deciding time adjustments';
