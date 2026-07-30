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
 * Full-page-load resilience: the run is also persisted to sessionStorage
 * (start time + mute state). If anything hard-navigates mid-song (e.g. the
 * router's RSC fetch falls back to a browser navigation), the toast — which
 * the root layout mounts on every document — calls
 * `resumeCarlaSongIfPending()` and playback picks up at the correct offset,
 * with the fade still landing at 26s and the stop at 30s from the ORIGINAL
 * start. A resume on a fresh document has no user gesture yet, so a blocked
 * play() there falls into the usual tap-anywhere recovery.
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

/**
 * The current run, persisted per-tab so a hard navigation can't kill the song.
 * `t0` is the epoch ms the 30s window started; `muted` mirrors the toggle so a
 * resume respects it.
 */
const RUN_KEY = 'carla_song_run_v1';
interface StoredRun {
  t0: number;
  muted: boolean;
}

function readRun(): StoredRun | null {
  try {
    const raw = sessionStorage.getItem(RUN_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as { t0?: unknown; muted?: unknown };
    if (typeof j?.t0 !== 'number' || !Number.isFinite(j.t0)) return null;
    return { t0: j.t0, muted: !!j.muted };
  } catch {
    return null;
  }
}

function writeRun(run: StoredRun): void {
  try {
    sessionStorage.setItem(RUN_KEY, JSON.stringify(run));
  } catch {
    /* ignore */
  }
}

function clearRun(): void {
  try {
    sessionStorage.removeItem(RUN_KEY);
  } catch {
    /* ignore */
  }
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
  clearRun();
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

/** Closing fade: ramp volume to 0 over `durationSeconds`, then stop. */
function beginFade(durationSeconds: number = FADE_SECONDS): void {
  const a = el;
  if (!a) {
    finish();
    return;
  }
  const steps = 40;
  const stepMs = Math.max(16, (durationSeconds * 1000) / steps);
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

/**
 * Schedule the fade/stop relative to `offsetSeconds` into the 30s window, so a
 * resumed run still fades at 26s and ends at 30s from the ORIGINAL start.
 */
function armTimeline(offsetSeconds: number = 0): void {
  clearTimers();
  const untilFade = CARLA_SONG_TOTAL_SECONDS - FADE_SECONDS - offsetSeconds;
  if (untilFade <= 0) {
    // Resumed inside the fade tail — fade out over whatever window remains.
    beginFade(Math.max(0.3, CARLA_SONG_TOTAL_SECONDS - offsetSeconds));
    return;
  }
  fadeStartTimer = setTimeout(beginFade, untilFade * 1000);
}

/**
 * Autoplay was refused — either the login page never got a real gesture, or a
 * resumed run landed on a fresh document (a new page has no gesture yet). The
 * very next tap/keypress anywhere restarts playback, resuming at the stored
 * run's current offset so the 30s window stays anchored to the original start.
 */
function installUnlock(): void {
  if (unlockInstalled || typeof window === 'undefined') return;
  unlockInstalled = true;
  const unlock = () => {
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
    unlockInstalled = false;
    if (state.status !== 'blocked') return;
    const run = readRun();
    if (run) {
      const elapsed = (Date.now() - run.t0) / 1000;
      if (elapsed < CARLA_SONG_TOTAL_SECONDS) {
        start(elapsed, run.t0, run.muted);
        return;
      }
      finish();
      return;
    }
    start();
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

/**
 * Begin (or resume) playback `offsetSeconds` into the 30s window. `t0Ms`
 * anchors the persisted run; omitted for a fresh start.
 */
function start(offsetSeconds = 0, t0Ms?: number, muted = false): void {
  try {
    clearTimers();
    if (!el) {
      el = new Audio(CARLA_SONG_SRC);
      el.preload = 'auto';
      el.addEventListener('ended', finish);
      // Missing/undecodable asset — stand down without ever showing the toast.
      el.addEventListener('error', finish);
    }
    // Persist BEFORE play resolves so a navigation racing the start still
    // finds the run and resumes on the next document.
    writeRun({ t0: t0Ms ?? Date.now() - offsetSeconds * 1000, muted });
    el.volume = VOLUME;
    el.muted = muted;
    // Optimistic: flips to 'blocked' or 'done' below if play() rejects.
    setState({ status: 'playing', muted });
    void el
      .play()
      .then(() => {
        const a = el;
        if (a && offsetSeconds > 0) {
          try {
            a.currentTime = offsetSeconds;
          } catch {
            /* seek is best-effort */
          }
        }
        armTimeline(offsetSeconds);
      })
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
 * The one sign-in entry point — called by the login page right before it
 * navigates into the app. No-ops for everyone but Carla, and won't restart
 * a run that's already going (the hand-off effect can fire more than once).
 */
export function startCarlaSongIfEligible(email: string | null | undefined): void {
  if (typeof window === 'undefined') return;
  if ((email ?? '').trim().toLowerCase() !== CARLA_SONG_EMAIL) return;
  if (state.status === 'playing' || state.status === 'blocked') return;
  start();
}

/**
 * Pick a persisted run back up after a full page load. Called by the toast on
 * mount (the root layout mounts it on every document). No-ops when nothing is
 * stored, the 30s window already elapsed, or a run is live in this module.
 * Skipped on /login: a fresh document there mid-window is the sign-out case,
 * and the song shouldn't haunt the sign-in screen.
 */
export function resumeCarlaSongIfPending(): void {
  if (typeof window === 'undefined') return;
  if (state.status === 'playing' || state.status === 'blocked') return;
  const run = readRun();
  if (!run) return;
  if (window.location.pathname.startsWith('/login')) {
    clearRun();
    return;
  }
  const elapsed = (Date.now() - run.t0) / 1000;
  if (elapsed >= CARLA_SONG_TOTAL_SECONDS) {
    clearRun();
    return;
  }
  start(elapsed, run.t0, run.muted);
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
  const run = readRun();
  if (run) writeRun({ ...run, muted });
  setState({ muted });
}

export function toggleCarlaSongMuted(): void {
  setCarlaSongMuted(!state.muted);
}

/** Dismiss from the toast — stops playback immediately. */
export function stopCarlaSong(): void {
  finish();
}
