/**
 * The NPD sync button's progress bar (src/components/npd/NpdGoogleSheetSync.tsx).
 * Pure, so the rules below are tested (sync-progress.test.ts).
 *
 * The bar follows the sync's REAL phases, not a timer: reading the Google Sheet →
 * (asking before it replaces a week that has rows) → putting the rows on the sheet
 * → saving. A phase's length is unknown, so each working phase is ONE long,
 * decelerating glide toward a ceiling it never passes. The browser runs it on the
 * compositor (Web Animations, transform only), so it stays smooth even while the
 * page is busy drawing hundreds of synced rows. A new phase glides on from wherever
 * the bar is; it never jumps back. Only `done` (the server confirmed the save) takes
 * it to the end, so a full bar always means saved.
 */

export type SyncPhase = 'reading' | 'confirm' | 'applying' | 'saving' | 'done' | 'failed';

/** Decelerating: quick to show it started, then a long crawl that never looks stuck. */
const GLIDE = 'cubic-bezier(0.08, 0.82, 0.17, 1)';
/** A confident arrival, for short known moves. */
const ARRIVE = 'cubic-bezier(0.16, 1, 0.3, 1)';

export type PhaseMotion =
  /** Glide from where the bar is to `to` (a share of the track, 0–1) over `ms`, then hold there. */
  | { readonly kind: 'glide'; readonly to: number; readonly ms: number; readonly easing: string }
  /** Freeze where it is (waiting for Replace / Cancel, or stopped by a failure). */
  | { readonly kind: 'hold' };

export const SYNC_PHASE_MOTION: Record<SyncPhase, PhaseMotion> = {
  reading: { kind: 'glide', to: 0.6, ms: 9000, easing: GLIDE },
  confirm: { kind: 'hold' },
  applying: { kind: 'glide', to: 0.78, ms: 2400, easing: ARRIVE },
  saving: { kind: 'glide', to: 0.95, ms: 6000, easing: GLIDE },
  done: { kind: 'glide', to: 1, ms: 420, easing: ARRIVE },
  failed: { kind: 'hold' },
};

/** For assistive tech: a whole-number reading per phase (the exact fill inside a phase is an estimate). */
export const SYNC_PHASE_VALUE: Record<SyncPhase, number | null> = {
  reading: 30,
  confirm: 60,
  applying: 70,
  saving: 85,
  done: 100,
  failed: null,
};

/** Phases a run ends in: nothing moves the bar out of them but a new run. */
export const isTerminalPhase = (p: SyncPhase) => p === 'done' || p === 'failed';

/** Phases whose length is unknown: the bar is moving and shows it is still working. */
export const isWorkingPhase = (p: SyncPhase) => p === 'reading' || p === 'applying' || p === 'saving';

/**
 * Where a phase's motion starts and ends, from the bar's current fill (0–1). A new
 * run starts empty; otherwise the bar never moves backwards, and a hold stays put.
 */
export function phaseMotionSpan(current: number, phase: SyncPhase, newRun: boolean): { from: number; to: number } {
  const from = newRun ? 0 : Math.min(1, Math.max(0, current));
  const m = SYNC_PHASE_MOTION[phase];
  return { from, to: m.kind === 'hold' ? from : Math.max(from, m.to) };
}

/** The X scale of a computed `transform` (`none`, `matrix(a, …)`, or `matrix3d(a, …)`). */
export function scaleXOf(transform: string): number {
  const m = /^matrix(?:3d)?\(([^,]+)/.exec(transform.trim());
  if (!m) return transform.trim() === 'none' ? 1 : 0;
  const a = Number(m[1]);
  return Number.isFinite(a) ? a : 0;
}
