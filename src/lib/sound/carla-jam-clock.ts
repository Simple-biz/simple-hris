/**
 * Pure rules for Carla's Jellyfish Jam bubble — no DOM, no audio.
 *
 * `carla-jam.ts` (the engine) feeds these the wall clock, the last input
 * timestamp, the tab's visibility and the button presses; this module decides
 * how much active time that earns, when the bubble is due, and what each
 * press moves the bubble to. Everything here is covered by
 * `carla-jam-clock.test.ts`.
 *
 * Governing doc: `docs/features/carla-jellyfish-bubble.md`.
 */

/** The one person who gets the bubble. A literal email match, never a role — the sign-in song's rule. */
export const CARLA_JAM_EMAIL = 'carla@simple.biz';

/** Active time between one bubble closing and the next one appearing. */
export const CARLA_JAM_ACTIVE_MS = 5 * 60_000;

/** Input older than this and the moment no longer counts as active. Reading a page counts for a minute. */
export const CARLA_JAM_IDLE_AFTER_MS = 60_000;

/**
 * The most a single tick may credit. The engine ticks every second, but a
 * throttled or slept tab can fire its next tick minutes later. Without the cap
 * that one late tick would credit the whole gap.
 */
export const CARLA_JAM_MAX_TICK_MS = 2_000;

/**
 * - `counting` — no bubble; active time accumulates.
 * - `offer`    — the jellyfish bubble is up, waiting for play or ✕.
 * - `playing`  — the song is audible.
 * - `paused`   — the player is up, the song is paused.
 */
export type JamPhase = 'counting' | 'offer' | 'playing' | 'paused';

export type JamEvent =
  /** The clock reached `CARLA_JAM_ACTIVE_MS`. */
  | 'due'
  /** The play button — on the bubble, or on the paused player. */
  | 'play'
  /** The pause button, or a Start Processing cue starting mid-song. */
  | 'pause'
  /** ✕ — on the bubble or on the player. */
  | 'close'
  /** The song reached its end. */
  | 'ended'
  /** The audio could not load or play. */
  | 'failed';

export interface JamClock {
  /** Active milliseconds earned since the last bubble closed. */
  activeMs: number;
  /** When the previous tick ran; `null` before the first one. */
  lastTickAt: number | null;
}

export interface JamTickInput {
  now: number;
  /** The last pointer / key / wheel / scroll / touch event, or `null` if none yet on this document. */
  lastInputAt: number | null;
  /** `document.visibilityState === 'visible'`. */
  visible: boolean;
}

export const EMPTY_JAM_CLOCK: JamClock = { activeMs: 0, lastTickAt: null };

export function isCarlaJamEmail(email: string | null | undefined): boolean {
  return (email ?? '').trim().toLowerCase() === CARLA_JAM_EMAIL;
}

/** Is `now` an active moment: the tab is visible and she touched it within the idle window? */
export function isJamActiveMoment(input: JamTickInput): boolean {
  if (!input.visible || input.lastInputAt === null) return false;
  return input.now - input.lastInputAt <= CARLA_JAM_IDLE_AFTER_MS;
}

/**
 * Advance the clock to `now`. The interval since the previous tick is credited
 * only if `now` is an active moment, and never more than `CARLA_JAM_MAX_TICK_MS`.
 * The first tick only sets the baseline. A clock that runs backwards credits nothing.
 */
export function tickJamClock(clock: JamClock, input: JamTickInput): JamClock {
  let credit = 0;
  if (clock.lastTickAt !== null && isJamActiveMoment(input)) {
    credit = Math.min(Math.max(input.now - clock.lastTickAt, 0), CARLA_JAM_MAX_TICK_MS);
  }
  return { activeMs: clock.activeMs + credit, lastTickAt: input.now };
}

export function isJamDue(clock: JamClock): boolean {
  return clock.activeMs >= CARLA_JAM_ACTIVE_MS;
}

/**
 * The bubble's state machine. An event that does not apply to the current
 * phase leaves it unchanged, so a double click or a late `ended` is harmless.
 * Every path back to `counting` restarts the 5 minutes (the engine resets the
 * clock on that edge).
 */
export function reduceJamPhase(phase: JamPhase, event: JamEvent): JamPhase {
  switch (event) {
    case 'due':
      return phase === 'counting' ? 'offer' : phase;
    case 'play':
      return phase === 'offer' || phase === 'paused' ? 'playing' : phase;
    case 'pause':
      return phase === 'playing' ? 'paused' : phase;
    case 'ended':
      return phase === 'playing' ? 'counting' : phase;
    case 'close':
    case 'failed':
      return 'counting';
  }
}

/** What survives a hard navigation, per tab (`sessionStorage`). */
export interface StoredJam {
  activeMs: number;
  phase: JamPhase;
  /** Seconds into the song, for a player that was up. */
  positionSec: number;
}

const PHASES: readonly JamPhase[] = ['counting', 'offer', 'playing', 'paused'];

/**
 * Parse the stored value. Anything malformed is `null`, and the bubble starts
 * from a fresh clock rather than guessing. `activeMs` is clamped to the
 * threshold so a tampered value can do no more than bring the bubble up.
 */
export function parseStoredJam(raw: string | null | undefined): StoredJam | null {
  if (!raw) return null;
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  const o = j as { activeMs?: unknown; phase?: unknown; positionSec?: unknown };
  if (typeof o.activeMs !== 'number' || !Number.isFinite(o.activeMs)) return null;
  if (typeof o.phase !== 'string' || !PHASES.includes(o.phase as JamPhase)) return null;
  const pos = typeof o.positionSec === 'number' && Number.isFinite(o.positionSec) && o.positionSec > 0
    ? o.positionSec
    : 0;
  return {
    activeMs: Math.min(Math.max(o.activeMs, 0), CARLA_JAM_ACTIVE_MS),
    phase: o.phase as JamPhase,
    positionSec: pos,
  };
}

/**
 * The phase a fresh document starts in. A song that was `playing` comes back
 * `paused`: a new document has no user gesture yet, so the browser would
 * refuse to autoplay it, and music must never start on its own anyway.
 */
export function restoredJamPhase(stored: StoredJam): JamPhase {
  return stored.phase === 'playing' ? 'paused' : stored.phase;
}
