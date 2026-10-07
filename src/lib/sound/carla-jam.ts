'use client';

/**
 * Carla's Jellyfish Jam bubble — the engine.
 *
 * While carla@simple.biz is signed in, every 5 minutes of ACTIVE use (tab
 * visible, input within the last minute) brings up a floating jellyfish
 * bubble. Pressing it plays the whole Jellyfish Jam; the player that replaces
 * the bubble can pause, resume and close. The 5 minutes restart only when the
 * bubble closes, so a bubble never stacks and never re-offers mid-song.
 *
 * Same shape as `carla-song.ts`: a module-level `HTMLAudioElement` and a
 * `useSyncExternalStore` store, driven by one component mounted in the root
 * layout (`CarlaJamBubble`). The rules live in `carla-jam-clock.ts` (pure,
 * tested); this file owns the listeners, the timer, the audio and the
 * per-tab persistence.
 *
 * Invariants (docs/features/carla-jellyfish-bubble.md):
 * - Audio starts ONLY from `playCarlaJam()`, i.e. from her click. A tick never
 *   plays, and a restore after a hard navigation comes back paused.
 * - Never two songs at once: no bubble while the Start Processing cue or the
 *   sign-in song is active, and a cue that starts mid-jam pauses the jam.
 * - Asset: the same small re-encode the Start Processing cue serves. A failed
 *   load or play closes the bubble and restarts the clock.
 */

import { isStagePreppedActive, subscribeStagePrepped } from '@/lib/sound/ping-chime';
import { isCarlaSongActive } from '@/lib/sound/carla-song';
import {
  EMPTY_JAM_CLOCK,
  isJamDue,
  parseStoredJam,
  reduceJamPhase,
  restoredJamPhase,
  tickJamClock,
  type JamClock,
  type JamEvent,
  type JamPhase,
} from '@/lib/sound/carla-jam-clock';

export const CARLA_JAM_SRC = '/sounds/jellyfish-jam.mp3';
export const CARLA_JAM_TITLE = 'Jellyfish Jam';
/** Short on purpose: "SpongeBob SquarePants" truncates in the 20rem player. */
export const CARLA_JAM_ARTIST = 'SpongeBob';
/** The installed re-encode's length. Only used for the progress line before the element has loaded. */
export const CARLA_JAM_FALLBACK_SECONDS = 151.5;

const VOLUME = 0.9;
const TICK_MS = 1_000;
/** While counting, persist the clock after this much new credit (plus on every phase change and on pagehide). */
const PERSIST_EVERY_MS = 5_000;
const STORE_KEY = 'carla_jam_bubble_v1';

const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'scroll', 'touchstart'] as const;
const LISTEN: AddEventListenerOptions = { passive: true, capture: true };

export interface CarlaJamState {
  phase: JamPhase;
}

let state: CarlaJamState = { phase: 'counting' };
const listeners = new Set<() => void>();

let clock: JamClock = EMPTY_JAM_CLOCK;
let persistedAtMs = 0;
/** Where the song resumes: the paused position, or the restored one after a hard navigation. */
let positionSec = 0;
/** A restored position still to be applied once the fresh element can seek. */
let pendingSeekSec = 0;

let el: HTMLAudioElement | null = null;
let armed = false;
let lastInputAt: number | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
let unsubscribeCue: (() => void) | null = null;

function setState(patch: Partial<CarlaJamState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

/** Subscribe to state changes (useSyncExternalStore-compatible). */
export function subscribeCarlaJam(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function getCarlaJamState(): CarlaJamState {
  return state;
}

const SERVER_STATE: CarlaJamState = { phase: 'counting' };
/** Stable SSR snapshot — the bubble is never up during hydration. */
export function getCarlaJamServerState(): CarlaJamState {
  return SERVER_STATE;
}

/** Seconds into the song and its length, for the player's progress line. */
export function getCarlaJamProgress(): { elapsed: number; duration: number } {
  let elapsed = positionSec;
  let duration = CARLA_JAM_FALLBACK_SECONDS;
  if (el) {
    try {
      if (!pendingSeekSec) elapsed = el.currentTime;
      if (Number.isFinite(el.duration) && el.duration > 0) duration = el.duration;
    } catch {
      /* ignore */
    }
  }
  return { elapsed: Math.min(Math.max(elapsed, 0), duration), duration };
}

// ── persistence (per tab) ────────────────────────────────────────────────

function currentPositionSec(): number {
  if (state.phase !== 'playing' && state.phase !== 'paused') return 0;
  if (el && !pendingSeekSec) {
    try {
      return el.currentTime;
    } catch {
      /* fall through */
    }
  }
  return positionSec;
}

function persist(): void {
  try {
    sessionStorage.setItem(
      STORE_KEY,
      JSON.stringify({ activeMs: clock.activeMs, phase: state.phase, positionSec: currentPositionSec() }),
    );
    persistedAtMs = clock.activeMs;
  } catch {
    /* storage unavailable — the bubble still works for this document */
  }
}

function forgetStored(): void {
  try {
    sessionStorage.removeItem(STORE_KEY);
  } catch {
    /* ignore */
  }
}

function restore(): void {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(STORE_KEY);
  } catch {
    return;
  }
  const stored = parseStoredJam(raw);
  if (!stored) return;
  clock = { activeMs: stored.activeMs, lastTickAt: null };
  persistedAtMs = stored.activeMs;
  const phase = restoredJamPhase(stored);
  if (phase === 'paused') {
    positionSec = stored.positionSec;
    pendingSeekSec = stored.positionSec;
  }
  if (phase !== state.phase) setState({ phase });
}

// ── phase transitions ────────────────────────────────────────────────────

function transition(event: JamEvent): void {
  const prev = state.phase;
  const next = reduceJamPhase(prev, event);
  if (next === prev) return;
  if (next === 'counting') {
    // Every way back to counting restarts the 5 minutes.
    clock = { activeMs: 0, lastTickAt: Date.now() };
    positionSec = 0;
    pendingSeekSec = 0;
  }
  setState({ phase: next });
  persist();
}

/** Another song is audible (or about to be): the Start Processing cue, or the sign-in song. */
function otherSongActive(): boolean {
  if (isStagePreppedActive()) return true;
  return isCarlaSongActive();
}

function tick(): void {
  const now = Date.now();
  if (state.phase !== 'counting') {
    // Frozen while the bubble or the player is up; keep the baseline current
    // so closing it never credits the time it was open.
    clock = { ...clock, lastTickAt: now };
    return;
  }
  clock = tickJamClock(clock, {
    now,
    lastInputAt,
    visible: typeof document !== 'undefined' && document.visibilityState === 'visible',
  });
  if (isJamDue(clock) && !otherSongActive()) {
    transition('due');
    return;
  }
  if (clock.activeMs - persistedAtMs >= PERSIST_EVERY_MS) persist();
}

// ── audio ────────────────────────────────────────────────────────────────

function onEnded(): void {
  transition('ended');
}

function onError(): void {
  dropElement();
  transition('failed');
}

function dropElement(): void {
  if (!el) return;
  el.removeEventListener('ended', onEnded);
  el.removeEventListener('error', onError);
  try {
    el.pause();
    el.removeAttribute('src');
    el.load();
  } catch {
    /* ignore */
  }
  el = null;
}

function ensureElement(): HTMLAudioElement {
  if (!el) {
    el = new Audio(CARLA_JAM_SRC);
    el.preload = 'auto';
    el.addEventListener('ended', onEnded);
    el.addEventListener('error', onError);
  }
  return el;
}

// ── public controls ──────────────────────────────────────────────────────

/** The play button, on the bubble or on the paused player. The ONLY place audio starts. */
export function playCarlaJam(): void {
  if (state.phase !== 'offer' && state.phase !== 'paused') return;
  let a: HTMLAudioElement;
  try {
    a = ensureElement();
    a.volume = VOLUME;
    // A fresh element can take a start position before it loads (the spec's
    // default playback start position); the re-seek after play() covers a
    // browser that ignores it.
    if (state.phase === 'offer') a.currentTime = 0;
    else if (pendingSeekSec > 0) a.currentTime = pendingSeekSec;
  } catch {
    dropElement();
    transition('failed');
    return;
  }
  transition('play');
  void a
    .play()
    .then(() => {
      if (pendingSeekSec > 0) {
        try {
          if (Math.abs(a.currentTime - pendingSeekSec) > 1) a.currentTime = pendingSeekSec;
        } catch {
          /* seek is best-effort */
        }
        pendingSeekSec = 0;
      }
    })
    .catch((err: unknown) => {
      if (el !== a) return; // already dropped or replaced
      const name = (err as { name?: string } | null)?.name;
      if (name === 'AbortError') return; // a pause raced the start
      if (name === 'NotAllowedError') {
        // Only reachable without a gesture; leave the player up, paused, for another press.
        transition('pause');
        return;
      }
      dropElement();
      transition('failed');
    });
}

export function pauseCarlaJam(): void {
  if (state.phase !== 'playing') return;
  if (el) {
    try {
      el.pause();
      if (!pendingSeekSec) positionSec = el.currentTime;
    } catch {
      /* ignore */
    }
  }
  transition('pause');
}

export function toggleCarlaJam(): void {
  if (state.phase === 'playing') pauseCarlaJam();
  else playCarlaJam();
}

/** ✕ — on the bubble (not now) or on the player (stop and close). Restarts the 5 minutes. */
export function closeCarlaJam(): void {
  if (el) {
    try {
      el.pause();
      el.currentTime = 0;
    } catch {
      /* ignore */
    }
  }
  transition('close');
}

// ── arming ───────────────────────────────────────────────────────────────

function onInput(): void {
  lastInputAt = Date.now();
}

function onPageHide(): void {
  persist();
}

function onVisibility(): void {
  if (document.visibilityState === 'hidden') persist();
}

function onCueChange(): void {
  if (isStagePreppedActive() && state.phase === 'playing') pauseCarlaJam();
}

/**
 * Start listening. Called by `CarlaJamBubble` when the signed-in session is
 * Carla's and the page is not /login. Idempotent.
 */
export function armCarlaJam(): void {
  if (armed || typeof window === 'undefined') return;
  armed = true;
  restore();
  clock = { ...clock, lastTickAt: null };
  for (const t of INPUT_EVENTS) window.addEventListener(t, onInput, LISTEN);
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onVisibility);
  unsubscribeCue = subscribeStagePrepped(onCueChange);
  ticker = setInterval(tick, TICK_MS);
  tick();
}

/**
 * Stop listening and silence the song. With `forget`, also wipe this tab's
 * stored clock and close the bubble: used when the session is not Carla's (a
 * sign-out, or someone else signed in on the same tab) and on /login.
 */
export function disarmCarlaJam(opts: { forget?: boolean } = {}): void {
  if (armed) {
    armed = false;
    for (const t of INPUT_EVENTS) window.removeEventListener(t, onInput, LISTEN);
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onVisibility);
    unsubscribeCue?.();
    unsubscribeCue = null;
    if (ticker) clearInterval(ticker);
    ticker = null;
  }
  if (state.phase === 'playing') pauseCarlaJam();
  lastInputAt = null;
  if (opts.forget) {
    dropElement();
    clock = EMPTY_JAM_CLOCK;
    persistedAtMs = 0;
    positionSec = 0;
    pendingSeekSec = 0;
    forgetStored();
    if (state.phase !== 'counting') setState({ phase: 'counting' });
    return;
  }
  if (typeof window !== 'undefined') persist();
}
