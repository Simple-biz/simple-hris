'use client';

/**
 * Sign-in songs — one per person, listed in `SIGNIN_SONGS` below. Carla's
 * (Anri, "I Can't Stop The Loneliness", 1983) was the first; Aliviah's
 * (Sidney Gish, "Impostor Syndrome") was added 2026-10-07 on Kane's ask.
 *
 * When a listed email signs in, a ~30-second clip of THAT person's song plays
 * right after the Simple login intro video hands off to the app, then fades
 * out. The gate is the literal email, never a role; anyone not in the table
 * gets nothing. The login page calls `startCarlaSongIfEligible(email)` at the
 * exact intro → dashboard hand-off; everything here lives at module level
 * (same pattern as `ping-chime.ts`'s stage-prepped player) so the audio keeps
 * playing through client-side route changes — including dashboard switches,
 * which go through `router.push` and never reload the page.
 *
 * Full-page-load resilience: the run is also persisted to sessionStorage
 * (start time + mute state + whose song). If anything hard-navigates mid-song
 * (e.g. the router's RSC fetch falls back to a browser navigation), the toast
 * — which the root layout mounts on every document — calls
 * `resumeCarlaSongIfPending()` and playback picks up at the correct offset,
 * with the fade still landing at 26s and the stop at 30s from the ORIGINAL
 * start. A resume on a fresh document has no user gesture yet, so a blocked
 * play() there falls into the usual tap-anywhere recovery.
 *
 * `CarlaSongToast` (mounted once in the root layout) subscribes to this
 * module to show the "Now playing" pill with a mute toggle. The pill shows
 * only once sound has actually started (`playing`) or a tap will start it
 * (`blocked`) — never while play() is still pending (`starting`), so an
 * asset that never loads never flashes a pill over silence.
 *
 * Assets: each song's clip is a committed ~40s CUT, never the full track
 * (docs/features/login-carla-song.md § The clips). A row whose cut is not in
 * the repo yet is `pending` and inert: nothing is fetched, nothing plays, no
 * pill, and a console warning says so. An installed clip that fails to load
 * or decode stands down the same way, logged with `console.error`.
 */

export const CARLA_SONG_EMAIL = 'carla@simple.biz';
export const ALIVIAH_SONG_EMAIL = 'aliviah@simple.biz';

/**
 * Where a person's cut lives, and whether it is committed. `carla-song.test.ts`
 * holds both states to the disk: an `installed` clip must exist, a `pending`
 * one must NOT — so committing a cut without flipping its row fails the suite.
 */
export interface SigninClip {
  status: 'installed' | 'pending';
  src: string;
}

export interface SigninSong {
  /** Lower-case, exact. The whole gate. */
  email: string;
  clip: SigninClip;
  title: string;
  artist: string;
  thumb: string;
  /** Shown if `thumb` fails to load; with none, the pill drops the art. */
  thumbFallback?: string;
}

export const SIGNIN_SONGS: readonly SigninSong[] = [
  {
    email: CARLA_SONG_EMAIL,
    clip: { status: 'installed', src: '/sounds/carla-song.mp3' },
    title: "I Can't Stop The Loneliness",
    artist: 'Anri',
    thumb: '/carla-song-thumb.jpg',
    thumbFallback: '/carla-song-thumb.svg',
  },
  {
    email: ALIVIAH_SONG_EMAIL,
    // PENDING (item 386): Kane supplies the track; the 40s cut lands here.
    clip: { status: 'pending', src: '/sounds/aliviah-song.mp3' },
    title: 'Impostor Syndrome',
    artist: 'Sidney Gish',
    thumb: '/aliviah-song-thumb.jpg',
  },
];

/** The song for this email, or null — trims and case-folds, nothing looser. */
export function signinSongFor(email: string | null | undefined): SigninSong | null {
  const e = (email ?? '').trim().toLowerCase();
  if (!e) return null;
  return SIGNIN_SONGS.find((s) => s.email === e) ?? null;
}

/** Total audible run, including the fade tail. */
export const CARLA_SONG_TOTAL_SECONDS = 30;
/** How long the closing fade lasts (the last N seconds of the run). */
const FADE_SECONDS = 4;
const VOLUME = 0.9;
/** A resume further than this from where the run should be is re-seeked once sound starts. */
const SEEK_TOLERANCE_SECONDS = 0.75;

export type CarlaSongStatus =
  | 'idle'
  /** play() called, no sound yet. The run is live, but the pill stays hidden. */
  | 'starting'
  /** play() was refused by the autoplay policy — waiting on any tap/keypress. */
  | 'blocked'
  | 'playing'
  | 'done';

export interface CarlaSongState {
  status: CarlaSongStatus;
  muted: boolean;
  /** Whose song the current (or last) run is; null before any run. */
  song: SigninSong | null;
}

let el: HTMLAudioElement | null = null;
/** The song `el` was built for — a different person's run rebuilds it. */
let elSong: SigninSong | null = null;
let state: CarlaSongState = { status: 'idle', muted: false, song: null };
const listeners = new Set<() => void>();

/**
 * Bumped by every start and every finish. A play() that settles after its run
 * was stopped or superseded sees a different number and does nothing — so a
 * late resolve can never revive a stopped run.
 */
let runSeq = 0;

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
const SERVER_STATE: CarlaSongState = { status: 'idle', muted: false, song: null };
export function getCarlaSongServerState(): CarlaSongState {
  return SERVER_STATE;
}

/** A run is in progress — audible, about to be, or waiting on a tap. Guards re-entry and the jam bubble. */
export function isCarlaSongActive(status: CarlaSongStatus = state.status): boolean {
  return status === 'starting' || status === 'blocked' || status === 'playing';
}

/** The pill shows only once there is sound, or a tap will bring it — never while play() is pending. */
export function isCarlaSongPillVisible(status: CarlaSongStatus): boolean {
  return status === 'playing' || status === 'blocked';
}

/**
 * The current run, persisted per-tab so a hard navigation can't kill the song.
 * `t0` is the epoch ms the 30s window started; `muted` mirrors the toggle so a
 * resume respects it; `email` says whose song to resume. v1 runs (no email)
 * are not read — a run lasts 30s, so nothing worth keeping is lost.
 */
const RUN_KEY = 'carla_song_run_v2';
interface StoredRun {
  t0: number;
  muted: boolean;
  email: string;
}

/** The stored run and its song, or null when absent, malformed, or for an email not in the table. */
function readRun(): { run: StoredRun; song: SigninSong } | null {
  try {
    const raw = sessionStorage.getItem(RUN_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as { t0?: unknown; muted?: unknown; email?: unknown };
    if (typeof j?.t0 !== 'number' || !Number.isFinite(j.t0)) return null;
    if (typeof j.email !== 'string') return null;
    const song = signinSongFor(j.email);
    if (!song) return null;
    return { run: { t0: j.t0, muted: !!j.muted, email: song.email }, song };
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

/** Stop playback and settle into 'done' (idempotent — ended/error/fade/stop all land here). */
function finish(): void {
  runSeq += 1;
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

/**
 * Drop the audio element so the next start builds a fresh one — for a
 * different person's song, or after an error (an element that failed to load
 * stays failed, and reusing it would sink every later start in this session).
 */
function releaseElement(): void {
  if (!el) return;
  try {
    el.removeEventListener('ended', finish);
    el.removeEventListener('error', onElementError);
    el.pause();
  } catch {
    /* ignore */
  }
  el = null;
  elSong = null;
}

/** The clip failed to load or decode (404, bad deploy, network) — say so, and stand down. */
function onElementError(): void {
  console.error(`[signin-song] ${elSong?.clip.src ?? 'clip'} failed to load; nothing plays`);
  releaseElement();
  finish();
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
    const stored = readRun();
    if (stored) {
      start(stored.song, stored.run.t0, stored.run.muted);
      return;
    }
    if (state.song) start(state.song);
    else finish();
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

/**
 * Begin `song`, or resume the run anchored at `t0Ms`. A fresh start (no
 * `t0Ms`) re-anchors the window to the moment sound actually begins, so a
 * slow load never shortens the 30 seconds. A resume is placed by the wall
 * clock when sound begins, so a slow load never stretches it past 0:30.
 */
function start(song: SigninSong, t0Ms?: number, muted = false): void {
  if (song.clip.status !== 'installed') {
    finish();
    return;
  }
  const src = song.clip.src;
  const run = ++runSeq;
  try {
    clearTimers();
    if (el && elSong !== song) releaseElement();
    if (!el) {
      el = new Audio(src);
      elSong = song;
      el.preload = 'auto';
      el.addEventListener('ended', finish);
      el.addEventListener('error', onElementError);
    }
    const anchor = t0Ms ?? Date.now();
    const offset = (Date.now() - anchor) / 1000;
    if (offset >= CARLA_SONG_TOTAL_SECONDS) {
      finish();
      return;
    }
    // Persist BEFORE play resolves so a navigation racing the start still
    // finds the run and resumes on the next document.
    writeRun({ t0: anchor, muted, email: song.email });
    // Seek BEFORE play() so a resume starts at its offset, not at 0:00. Before
    // metadata loads this sets the default playback start position; the
    // resolve handler re-seeks any browser that ignored it.
    if (offset > 0) {
      try {
        el.currentTime = offset;
      } catch {
        /* corrected once sound starts */
      }
    }
    el.volume = VOLUME;
    el.muted = muted;
    setState({ status: 'starting', muted, song });
    const a = el;
    void a
      .play()
      .then(() => {
        if (run !== runSeq) return; // stopped or superseded while loading
        let at = 0;
        if (t0Ms === undefined) {
          writeRun({ t0: Date.now(), muted: state.muted, email: song.email });
        } else {
          at = (Date.now() - t0Ms) / 1000;
          if (at >= CARLA_SONG_TOTAL_SECONDS) {
            finish();
            return;
          }
          if (Math.abs(a.currentTime - at) > SEEK_TOLERANCE_SECONDS) {
            try {
              a.currentTime = at;
            } catch {
              /* seek is best-effort */
            }
          }
        }
        setState({ status: 'playing' });
        armTimeline(at);
      })
      .catch((err: unknown) => {
        if (run !== runSeq) return; // our own pause() aborting a stopped run
        const name = (err as { name?: string } | null)?.name;
        if (name === 'NotAllowedError') {
          setState({ status: 'blocked' });
          installUnlock();
          return;
        }
        console.error(`[signin-song] ${src} would not play (${name ?? 'unknown error'}); nothing plays`);
        releaseElement();
        finish();
      });
  } catch (err) {
    console.error(`[signin-song] ${src} could not start; nothing plays`, err);
    releaseElement();
    finish();
  }
}

/**
 * The one sign-in entry point — called by the login page right before it
 * navigates into the app, with whoever just signed in. A live run that is not
 * theirs is stopped (nobody inherits the last person's song). A repeat call
 * for the person already playing is a no-op (the hand-off effect can fire more
 * than once). No-ops for anyone not in `SIGNIN_SONGS`; a `pending` clip warns
 * and plays nothing.
 */
export function startCarlaSongIfEligible(email: string | null | undefined): void {
  if (typeof window === 'undefined') return;
  const song = signinSongFor(email);
  if (isCarlaSongActive()) {
    if (song && state.song === song) return;
    finish();
  }
  if (!song) return;
  if (song.clip.status !== 'installed') {
    console.warn(`[signin-song] ${song.email}: clip pending (${song.clip.src} is not committed); nothing plays`);
    return;
  }
  start(song);
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
  if (isCarlaSongActive()) return;
  const stored = readRun();
  if (!stored) {
    // Absent, malformed, or for an email no longer listed — never resume it.
    clearRun();
    return;
  }
  if (window.location.pathname.startsWith('/login')) {
    clearRun();
    return;
  }
  if ((Date.now() - stored.run.t0) / 1000 >= CARLA_SONG_TOTAL_SECONDS) {
    clearRun();
    return;
  }
  start(stored.song, stored.run.t0, stored.run.muted);
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
  const stored = readRun();
  if (stored) writeRun({ ...stored.run, muted });
  setState({ muted });
}

export function toggleCarlaSongMuted(): void {
  setCarlaSongMuted(!state.muted);
}

/** Dismiss from the toast — stops playback immediately. */
export function stopCarlaSong(): void {
  finish();
}
