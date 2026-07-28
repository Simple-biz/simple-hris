/**
 * When does the Readiness tab celebrate? Pure decision logic for the 100%
 * confetti moment, split out of the pane (like `readiness-score.ts`) so the
 * rule is unit-testable: celebrate ONLY a live transition — the SAME week was
 * last seen not-fully-ready and now reads a full 100/Ready while the tab is
 * open. Opening onto an already-clean week, or switching weeks onto one, is
 * not a moment (nothing happened in front of the accountant); a score that
 * dips and clears again is a real re-transition and celebrates again.
 *
 * No I/O, no framework — the caller (the Readiness pane) threads the previous
 * watch state through a ref and owns the actual effect (confetti, reduced
 * motion, where the burst erupts from).
 */

import type { ReadinessScore } from './readiness-score';

/** What the pane remembers between Readiness payloads: which week it was
 *  looking at, and whether that week already read fully ready. */
export interface ReadyWatchState {
  /** Week identity — the Hubstaff source file (or the week label pre-upload),
   *  so a week switch can never impersonate a live transition. */
  week: string;
  fullyReady: boolean;
}

/** A full 100/Ready — the dial's own definition. `value` is the exact
 *  component-points sum, and the composer refuses grade 'ready' on a degraded
 *  (partial-data) load, so this can never bless a number that only LOOKS
 *  clean because a source failed to read. */
export function isFullyReady(score: Pick<ReadinessScore, 'value' | 'grade'>): boolean {
  return score.value >= 100 && score.grade === 'ready';
}

/** Fold one fresh Readiness payload into the watch state: returns whether THIS
 *  payload is the celebration moment, and the state to remember for the next
 *  one. `prev === null` (first payload of the mount) never celebrates — the
 *  accountant didn't watch it happen. */
export function celebrationStep(
  prev: ReadyWatchState | null,
  week: string,
  score: Pick<ReadinessScore, 'value' | 'grade'>,
): { celebrate: boolean; next: ReadyWatchState } {
  const fullyReady = isFullyReady(score);
  return {
    celebrate: fullyReady && prev !== null && prev.week === week && !prev.fullyReady,
    next: { week, fullyReady },
  };
}
