/**
 * Pure decision rules behind the Payroll Wizard's week-selector **replay**.
 *
 * Switching the selector to a closed week must show that week as it was paid.
 * Two ways that failed, both of which these functions exist to make provable:
 *
 *  1. The PAB / Tech auto-toggle effects re-derive eligibility from TODAY's
 *     inputs (live PAB exclusions, current holiday list, current dispute set,
 *     current master start dates) and ran on replays too — overwriting the
 *     week's own saved verdicts a beat after they hydrated. A closed week then
 *     showed the bonuses it WOULD earn if run today, and any later change to
 *     those inputs silently rewrote history.
 *  2. The two KPI-amount loaders are keyed on the pay week and load on their own
 *     clock, so a week switch left a window in which the previous week's amounts
 *     were still in state — long enough for the 1.5s-debounced final-pay
 *     publisher to persist them under the NEW week's key, which is what Payment
 *     Dispatch prices from.
 *
 * Governing rules these encode:
 *  - `docs/reference/business-logic.md` — the wizard applies live data "only when
 *    `!isReplay`, so historical replays of past periods stay accurate".
 *  - ...and the same doc's 2026-07-17 "Replay" note: an EMPTY saved snapshot
 *    counts as ABSENT and falls back to live computation, because suppressing
 *    live computation on `{}` once made a payout week read ₱0 for everyone.
 *  - memory `paystub-tab-exact-recovery` — a past week's bonus lines are read
 *    from what was saved, never re-derived, which "diverges on manual toggles /
 *    post-hoc dispute/config drift and produced phantom bonus lines".
 */

/** What the Additions blob knows about one employee's one bonus toggle. */
export type SavedToggle = boolean | undefined;

/**
 * Whether a replayed week's saved bonus toggles are authoritative right now.
 *
 * @param isReplay        the selector is on a file other than the newest upload
 * @param savedTogglesFor the file whose hydrated blob carried a NON-EMPTY
 *                        `employeeBonuses` map (`null` = none did)
 * @param sourceFile      the file currently selected
 *
 * All three have to agree. `savedTogglesFor` is compared against `sourceFile`
 * rather than merely being non-null because the marker outlives a week switch by
 * one render, and a marker from the previously-viewed week must never authorize
 * freezing this one.
 */
export function shouldFreezeReplayBonusToggles(
  isReplay: boolean,
  savedTogglesFor: string | null,
  sourceFile: string | null,
): boolean {
  if (!isReplay) return false;
  if (savedTogglesFor === null || sourceFile === null) return false;
  return savedTogglesFor === sourceFile;
}

/**
 * The value an auto-toggle effect should write for one employee, or `null` to
 * leave the toggle exactly as it is.
 *
 * While frozen this only ever FILLS A GAP: an employee the blob has a verdict
 * for keeps it (that is the freeze), but one it never covered — joined the
 * roster or the department after the lock-in — still gets their live verdict
 * instead of a silent `false`. That is the same rule `effectivePabStatus`
 * applies to employees missing from a frozen PAB snapshot.
 */
export function resolveBonusToggle(
  frozen: boolean,
  saved: SavedToggle,
  liveEligible: boolean,
): boolean | null {
  if (frozen && saved !== undefined) return null;
  if ((saved ?? false) === liveEligible) return null;
  return liveEligible;
}

/**
 * A week-keyed load marker. `null` means "not loaded" — in flight, or a read
 * that failed. `{ week }` means the maps genuinely hold that week's data, and
 * `{ week: null }` is the legitimate "no Hubstaff file selected" load.
 *
 * An object rather than a bare `string | null` precisely so those last two are
 * distinguishable without a sentinel string: `hubstaffWeekStart` is itself
 * nullable, and a sentinel would make "loaded for no file" and "not loaded"
 * compare equal — which is the comparison the publisher gate depends on.
 */
export type KpiLoadMarker = { week: string | null } | null;

/**
 * Whether a KPI-amount map can be trusted as this week's. Gates the final-pay
 * snapshot publisher: while this is false the maps are either mid-flight, or
 * empty for a reason nobody has been told, and writing them would put one week's
 * KPI bonuses (or none at all) onto another week's pay.
 */
export function kpiAmountsMatchWeek(marker: KpiLoadMarker, week: string | null): boolean {
  if (marker === null) return false;
  return marker.week === week;
}
