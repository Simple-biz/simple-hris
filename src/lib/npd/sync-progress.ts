/**
 * The NPD sync button's progress bar (src/components/npd/NpdGoogleSheetSync.tsx).
 * Pure, so the rules below are tested (sync-progress.test.ts).
 *
 * The bar follows the sync's REAL phases, not a timer: reading the Google Sheet →
 * (asking before it replaces a week that has rows) → putting the rows on the sheet
 * → saving. Inside a phase it eases toward that phase's ceiling, because a phase's
 * length is unknown. It never reaches 100 by itself: only `done` (the server
 * confirmed the save) fills it, so a full bar always means saved.
 */

export type SyncPhase = 'reading' | 'confirm' | 'applying' | 'saving' | 'done' | 'failed';

/** Where each phase starts and the furthest it may creep. */
export const SYNC_PHASE_RANGE: Record<SyncPhase, { from: number; ceiling: number }> = {
  reading: { from: 4, ceiling: 60 },
  confirm: { from: 60, ceiling: 60 },
  applying: { from: 60, ceiling: 78 },
  saving: { from: 78, ceiling: 95 },
  done: { from: 100, ceiling: 100 },
  failed: { from: 0, ceiling: 100 },
};

/** Phases a run ends in: nothing moves the bar out of them but a new run. */
export const isTerminalPhase = (p: SyncPhase) => p === 'done' || p === 'failed';

/** Phases whose length is unknown: the bar eases forward while they run. */
export const isWorkingPhase = (p: SyncPhase) => p === 'reading' || p === 'applying' || p === 'saving';

/** Entering a phase: jump to its start, never backwards. A failure keeps where it stopped. */
export function enterSyncPhase(pct: number, phase: SyncPhase): number {
  if (phase === 'done') return 100;
  if (phase === 'failed') return pct;
  return Math.max(pct, SYNC_PHASE_RANGE[phase].from);
}

/** One tick inside a working phase: close a share of the gap to the ceiling. Never past it, never back. */
export function creepSyncProgress(pct: number, phase: SyncPhase, share = 0.06): number {
  if (!isWorkingPhase(phase)) return pct;
  const ceiling = SYNC_PHASE_RANGE[phase].ceiling;
  if (pct >= ceiling) return pct;
  return Math.min(ceiling, pct + Math.max(0.05, (ceiling - pct) * share));
}
