'use client';

/**
 * Carla's sign-in serenade — Anri, "I Can't Stop The Loneliness" (1983).
 *
 * When carla@simple.biz signs in, a ~30-second clip of the song plays right
 * after the Simple login intro video hands off to the app, then fades out.
 * The login page calls `startCarlaSongIfEligible(email)` at the exact
 * intro → dashboard hand-off; everything here lives at module level (same
 * pattern as `ping-chime.ts`'s stage-prepped player) so the audio keeps
 * playing through client-side route changes — including dashboard switches,
 * which go through `router.push` and never reload the page.
 *
 * `CarlaSongToast` (mounted once in the root layout) subscribes to this
 * module to show the "Now playing" pill with a mute toggle.
 *
 * Asset: `public/sounds/carla-song.mp3`. If the file is missing the whole
 * feature quietly stands down — play() rejects, we finish(), no toast shows.
 */

export const CARLA_SONG_EMAIL = 'carla@simple.biz';
export const CARLA_SONG_SRC = '/sounds/carla-song.mp3';
export const CARLA_SONG_TITLE = "I Can't Stop The Loneliness";
export const CARLA_SONG_ARTIST = 'Anri';

/** Total audible run, including the fade tail. */
export const CARLA_SONG_TOTAL_SECONDS = 30;
/** How long the closing fade lasts (the last N seconds of the run). */
const FADE_SECONDS = 4;
const VOLUME = 0.9;

export type CarlaSongStatus =
  | 'idle'
  /** play() was refused by the autoplay policy — waiting on any tap/keypress. */
  | 'blocked'
  | 'playing'
  | 'done';

export interface CarlaSongState {
  status: CarlaSongStatus;
  muted: boolean;
}

let el: HTMLAudioElement | null = null;
let state: CarlaSongState = { status: 'idle', muted: false };
const listeners = new Set<() => void>();

let fadeStartTimer: ReturnType<typeof setTimeout> | null = null;
let fadeInterval: ReturnType<typeof setInterval> | null = null;
let unlockInstalled = false;

function setState(patch: Partial<CarlaSongState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

/** Subscribe to state changes (useSyncExternalStore-compatible). */
export function subscribeCarlaSong(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function getCarlaSongState(): CarlaSongState {
  return state;
}

/** Stable snapshot for SSR — the song can never be playing during hydration. */
const SERVER_STATE: CarlaSongState = { status: 'idle', muted: false };
export function getCarlaSongServerState(): CarlaSongState {
  return SERVER_STATE;
}

/** Seconds into the clip, clamped to the 30s run — drives the toast progress bar. */
export function getCarlaSongElapsedSeconds(): number {
  if (!el) return 0;
  try {
    return Math.min(el.currentTime, CARLA_SONG_TOTAL_SECONDS);
  } catch {
    return 0;
  }
}

function clearTimers(): void {
  if (fadeStartTimer) {
    clearTimeout(fadeStartTimer);
    fadeStartTimer = null;
  }
  if (fadeInterval) {
    clearInterval(fadeInterval);
    fadeInterval = null;
  }
}

/** Stop playback and settle into 'done' (idempotent — ended/error/fade all land here). */
function finish(): void {
  clearTimers();
  if (el) {
    try {
      el.pause();
      el.currentTime = 0;
      el.volume = VOLUME;
    } catch {
      /* ignore */
    }
  }
  if (state.status !== 'done') setState({ status: 'done' });
}

/** Last FADE_SECONDS of the run: ramp volume to 0, then stop. */
function beginFade(): void {
  const a = el;
  if (!a) {
    finish();
    return;
  }
  const steps = 40;
  const stepMs = (FADE_SECONDS * 1000) / steps;
  const startVol = a.volume;
  let i = 0;
  fadeInterval = setInterval(() => {
    i += 1;
    const next = startVol * (1 - i / steps);
    try {
      a.volume = next > 0 ? next : 0;
    } catch {
      /* ignore */
    }
    if (i >= steps) finish();
  }, stepMs);
}

function armTimeline(): void {
  clearTimers();
  fadeStartTimer = setTimeout(beginFade, (CARLA_SONG_TOTAL_SECONDS - FADE_SECONDS) * 1000);
}

/**
 * Autoplay was refused (only possible when the login page never got a real
 * gesture — normally the "Continue with Google" click satisfies the policy).
 * The very next tap/keypress anywhere restarts playback.
 */
function installUnlock(): void {
  if (unlockInstalled || typeof window === 'undefined') return;
  unlockInstalled = true;
  const unlock = () => {
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
    unlockInstalled = false;
    if (state.status === 'blocked') start();
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

function start(): void {
  try {
    clearTimers();
    if (!el) {
      el = new Audio(CARLA_SONG_SRC);
      el.preload = 'auto';
      el.addEventListener('ended', finish);
      // Missing/undecodable asset — stand down without ever showing the toast.
      el.addEventListener('error', finish);
    }
    el.currentTime = 0;
    el.volume = VOLUME;
    el.muted = false;
    // Optimistic: flips to 'blocked' or 'done' below if play() rejects.
    setState({ status: 'playing', muted: false });
    void el
      .play()
      .then(armTimeline)
      .catch((err: unknown) => {
        const name = (err as { name?: string } | null)?.name;
        if (name === 'NotAllowedError') {
          setState({ status: 'blocked' });
          installUnlock();
        } else {
          // NotSupportedError etc. — asset missing; quietly no-op.
          finish();
        }
      });
  } catch {
    finish();
  }
}

/**
 * The one public entry point — called by the login page right before it
 * navigates into the app. No-ops for everyone but Carla, and won't restart
 * a run that's already going (the hand-off effect can fire more than once).
 */
export function startCarlaSongIfEligible(email: string | null | undefined): void {
  if (typeof window === 'undefined') return;
  if ((email ?? '').trim().toLowerCase() !== CARLA_SONG_EMAIL) return;
  if (state.status === 'playing' || state.status === 'blocked') return;
  start();
}

/** Mute keeps the 30s timeline running — unmuting rejoins the song mid-play. */
export function setCarlaSongMuted(muted: boolean): void {
  if (el) {
    try {
      el.muted = muted;
    } catch {
      /* ignore */
    }
  }
  setState({ muted });
}

export function toggleCarlaSongMuted(): void {
  setCarlaSongMuted(!state.muted);
}

/** Dismiss from the toast — stops playback immediately. */
export function stopCarlaSong(): void {
  finish();
}
