'use client';

/**
 * Sound cues for the Accounting collaboration layer.
 *
 * Two tiny synthesized Web Audio cues:
 *   - `playPingChime()`  : a friendly rising 3-note sparkle, played on the
 *                          RECIPIENT's side when someone pings them.
 *   - `playPingSent()`   : a soft, short blip, played on the SENDER's side as
 *                          tactile "it went out" feedback.
 *
 * Plus the "stage prepped" cue further down, which plays a shipped recording
 * (`public/sounds/jellyfish-jam.mp3`) rather than a synthesized sound.
 *
 * A single module-level AudioContext is shared by both. Browser autoplay
 * policies start the context 'suspended' until a user gesture, so we install a
 * one-time pointer/key unlock handler and flush any cue that was requested
 * while audio was still locked — mirroring the proven pattern in
 * `useNotificationChime`.
 */

let ctx: AudioContext | null = null;
let unlockInstalled = false;
// Cue queued while the AudioContext was still locked, flushed on first gesture.
let pending: (() => void) | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctx) ctx = new Ctx();
    } catch {
      /* no Web Audio support — callers degrade to silent */
      return null;
    }
  }
  return ctx;
}

function installUnlock(): void {
  if (unlockInstalled || typeof window === 'undefined') return;
  unlockInstalled = true;
  const unlock = () => {
    const c = getCtx();
    if (!c) return;
    void c
      .resume()
      .then(() => {
        if (c.state === 'running' && pending) {
          const cue = pending;
          pending = null;
          cue();
        }
      })
      .catch(() => {});
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

/** Run `emit` now if audio is unlocked, else queue it for the next gesture. */
function withCtx(emit: (c: AudioContext) => void): void {
  installUnlock();
  const c = getCtx();
  if (!c) return;
  if (c.state === 'running') {
    emit(c);
    return;
  }
  pending = () => emit(c);
  void c
    .resume()
    .then(() => {
      if (c.state === 'running' && pending) {
        const cue = pending;
        pending = null;
        cue();
      }
    })
    .catch(() => {});
}

/** Recipient cue: a bright rising 3-note sparkle that decays quickly. */
export function playPingChime(): void {
  withCtx((c) => {
    const now = c.currentTime;
    // [freq, start offset, peak gain, waveform]
    const notes: Array<[number, number, number, OscillatorType]> = [
      [784, 0, 0.16, 'sine'], // G5
      [1175, 0.09, 0.13, 'sine'], // D6
      [1568, 0.18, 0.09, 'triangle'], // G6 sparkle tail
    ];
    for (const [freq, delay, gain, type] of notes) {
      const osc = c.createOscillator();
      const env = c.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      env.gain.setValueAtTime(0, now + delay);
      env.gain.linearRampToValueAtTime(gain, now + delay + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.42);
      osc.connect(env).connect(c.destination);
      osc.start(now + delay);
      osc.stop(now + delay + 0.46);
    }
  });
}

/**
 * Payment-confirmed cue: a crisp, satisfying two-note "tick" played when a
 * dispatch is marked paid and confirmed sent. A short high tick lands first
 * for the tactile "click", then a warm rising note resolves upward so it reads
 * as a positive confirmation rather than a plain UI beep.
 */
export function playPaymentConfirmed(): void {
  withCtx((c) => {
    const now = c.currentTime;

    // 1) Crisp tick — a very short, bright triangle blip for the "click".
    const tick = c.createOscillator();
    const tickEnv = c.createGain();
    tick.type = 'triangle';
    tick.frequency.setValueAtTime(2100, now);
    tickEnv.gain.setValueAtTime(0, now);
    tickEnv.gain.linearRampToValueAtTime(0.09, now + 0.004);
    tickEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
    tick.connect(tickEnv).connect(c.destination);
    tick.start(now);
    tick.stop(now + 0.09);

    // 2) Confident rising resolve — C6 → G6, sine for a clean, warm tone.
    const notes: Array<[number, number, number]> = [
      [1046.5, 0.05, 0.14], // C6
      [1568.0, 0.14, 0.12], // G6
    ];
    for (const [freq, delay, gain] of notes) {
      const osc = c.createOscillator();
      const env = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      env.gain.setValueAtTime(0, now + delay);
      env.gain.linearRampToValueAtTime(gain, now + delay + 0.01);
      env.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.34);
      osc.connect(env).connect(c.destination);
      osc.start(now + delay);
      osc.stop(now + delay + 0.38);
    }
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * "Stage prepped" cue = SpongeBob's "Jellyfish Jam", played when the clerk hits
 * Start Processing (Payroll Wizard AND Payment Dispatch — deliberately the same
 * cue for the same action). Plays the Kane-supplied recording at
 * `public/sounds/jellyfish-jam.mp3` (replaced `truckstart.mp3` 2026-09-15, which
 * had replaced the synthesized Lamborghini V12). Since 2026-09-25 that file is
 * the WHOLE song (Kane: "it needs to play the whole song"), re-encoded small so
 * it downloads fast, and warmed by `prefetchStagePrepped()` before anyone clicks.
 * If the asset is missing or fails to decode the cue is a silent no-op.
 *
 * Fired from the Start Processing CLICK — as the confirm modal OPENS, not from
 * the confirm inside it (Kane 2026-09-15). Both are user gestures, so autoplay
 * policy allows either. Deliberately NOT routed through `withCtx`: that queues a
 * cue for the next gesture, and music must never ambush someone on an unrelated
 * later click. A locked context just resumes and plays from the top.
 *
 * Two-phase lifetime, because the modal closes ~2s after confirm while the cue
 * is required to outlive it:
 *   play() — the button opened the modal. CANCELLING the modal kills the cue.
 *   hold() — the operator CONFIRMED. The run is protected from stopStagePrepped
 *            and plays the whole song.
 * Every run is still bounded — looped up to STAGE_PREPPED_MIN_SECONDS, faded at
 * STAGE_PREPPED_MAX_SECONDS — so "protected" can never mean "unbounded".
 * ──────────────────────────────────────────────────────────────────────────── */

const STAGE_PREPPED_VOLUME = 0.7;
const STAGE_PREPPED_SRC = '/sounds/jellyfish-jam.mp3';
// Ramp the tail down when the run CUTS the audio (a loop boundary or the
// ceiling) instead of letting it stop cold. A song that ends on its own keeps
// its real ending. Clamped to half the run so a short window never fades from
// the very start.
const STAGE_PREPPED_FADE_TAIL = 1.2;
// FLOOR, in seconds. A clip SHORTER than this LOOPS up to it, so re-trimming the
// asset can never quietly drop the cue below the >= 10s Kane asked for
// (2026-09-15).
export const STAGE_PREPPED_MIN_SECONDS = 12;
// CEILING, in seconds. The whole song plays (Kane 2026-09-25) — the installed
// track is 2:31 — but a held run is still bounded: swap in a ten-minute file and
// it is faded here, never minutes more of music behind the UI.
export const STAGE_PREPPED_MAX_SECONDS = 180;

/**
 * How long a run lasts for a clip of `clipSeconds`: the whole clip, looped up to
 * the floor, faded at the ceiling. An unreadable duration gets the floor.
 */
export function stagePreppedRunSeconds(clipSeconds: number): number {
  if (!Number.isFinite(clipSeconds) || clipSeconds <= 0) return STAGE_PREPPED_MIN_SECONDS;
  return Math.min(STAGE_PREPPED_MAX_SECONDS, Math.max(STAGE_PREPPED_MIN_SECONDS, clipSeconds));
}

/**
 * The COMPRESSED bytes are fetched once and cached; the decoded buffer is NOT.
 * Decoded, the 2:31 track is ~53MB of PCM, so each run decodes its own copy
 * (~0.25s) and lets it go when the run ends. A failed fetch or decode resolves
 * null (silent no-op) and clears the cache so the next click can retry.
 */
let stagePreppedBytes: Promise<ArrayBuffer | null> | null = null;
function fetchStagePreppedBytes(): Promise<ArrayBuffer | null> {
  if (!stagePreppedBytes) {
    stagePreppedBytes = fetch(STAGE_PREPPED_SRC)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .catch(() => {
        stagePreppedBytes = null;
        return null;
      });
  }
  return stagePreppedBytes;
}

/**
 * Warm the cue before anyone clicks — call on mount of a Start Processing
 * surface. The whole song is ~1.2MB, and the engine needs every byte before it
 * can decode, so without this the first press of the day would sit silent while
 * it downloaded. Idempotent; a failure just leaves the click to fetch it.
 */
export function prefetchStagePrepped(): void {
  if (typeof window === 'undefined') return;
  void fetchStagePreppedBytes();
}

function loadStagePrepped(c: AudioContext): Promise<AudioBuffer | null> {
  return fetchStagePreppedBytes()
    .then((bytes) => {
      if (!bytes) return null;
      // decodeAudioData DETACHES its input, so decode a copy and keep the
      // cached bytes usable for the next run.
      return c.decodeAudioData(bytes.slice(0));
    })
    .catch(() => {
      // Undecodable bytes: drop them so the next click refetches.
      stagePreppedBytes = null;
      return null;
    });
}

interface EngineRun {
  ctx: AudioContext;
  master: GainNode;
  sources: AudioScheduledSourceNode[];
}
let engineRun: EngineRun | null = null;

/**
 * Fade the running engine out over `fade` seconds, then stop every source and
 * drop it. Safe to call when nothing is playing.
 */
function killEngine(fade: number): void {
  const run = engineRun;
  if (!run) return;
  engineRun = null;
  const { ctx: c, master, sources } = run;
  const now = c.currentTime;
  const g = master.gain;
  try {
    if (typeof g.cancelAndHoldAtTime === 'function') {
      g.cancelAndHoldAtTime(now);
    } else {
      const held = g.value;
      g.cancelScheduledValues(now);
      g.setValueAtTime(held, now);
    }
    g.linearRampToValueAtTime(0, now + fade);
  } catch {
    /* param already torn down — the stop() below still ends it */
  }
  const at = now + fade + 0.05;
  for (const src of sources) {
    try {
      src.stop(at);
    } catch {
      /* already ended */
    }
  }
  window.setTimeout(
    () => {
      try {
        master.disconnect();
      } catch {
        /* already detached */
      }
    },
    (fade + 0.25) * 1000,
  );
}

// Generation token: a stop or re-trigger while the mp3 is still being fetched/
// decoded invalidates that in-flight run, so a slow first load can never start
// playing after the modal has already closed.
let stagePreppedGen = 0;
// Set by `holdStagePrepped()` when the operator CONFIRMS. A held run plays the
// whole song and ignores `stopStagePrepped()`, because the modal closes ~2s
// after confirm and the cue has to outlive it. An UNHELD run (modal opened,
// then cancelled) is still killed by it, exactly as before.
let stagePreppedHeld = false;
// True between the click and the moment the fetch/decode settles. A hold taken
// during that window has no `engineRun` to point at yet, so protection has to
// cover the loading phase too — otherwise the modal closing first would cancel
// a run the operator already confirmed. A stop clears it along with the
// generation it cancels, so a cancelled load can never leave it stuck on.
let stagePreppedLoading = false;

/**
 * Is a cue run in flight — still loading, or audible? The peer modal stays open
 * for exactly as long as this is true (Kane 2026-09-25: "play the whole song
 * unless the modal is being closed"), so it can never close mid-song or sit on
 * after the song has ended.
 */
export function isStagePreppedActive(): boolean {
  return engineRun !== null || stagePreppedLoading;
}

const stagePreppedListeners = new Set<() => void>();
let stagePreppedLastActive = false;
/**
 * Emit on a real change only. Called at the END of each state transition, never
 * from inside one, so a re-trigger (old run killed, new one loading) never
 * flickers "inactive" at a listener.
 */
function notifyStagePrepped(): void {
  const active = isStagePreppedActive();
  if (active === stagePreppedLastActive) return;
  stagePreppedLastActive = active;
  for (const l of stagePreppedListeners) l();
}

/** Subscribe to `isStagePreppedActive()` changes (useSyncExternalStore-compatible). */
export function subscribeStagePrepped(onChange: () => void): () => void {
  stagePreppedListeners.add(onChange);
  return () => {
    stagePreppedListeners.delete(onChange);
  };
}

/**
 * Start the cue. Call this from the Start Processing CLICK, before the confirm
 * modal opens. Always leaves the run UNHELD, so a cancelled modal silences it.
 */
export function playStagePrepped(): void {
  const c = getCtx();
  if (!c) return;
  // Rapid re-trigger: snap the previous run off with a click-free 60ms fade
  // rather than layering a second engine on top of the first.
  killEngine(0.06);
  // A fresh press always starts an unheld run; the previous run's protection
  // must not leak forward and block the next `stopStagePrepped()`.
  stagePreppedHeld = false;
  if (c.state !== 'running') void c.resume().catch(() => {});

  const gen = ++stagePreppedGen;
  stagePreppedLoading = true;
  notifyStagePrepped();
  void loadStagePrepped(c).then((buf) => {
    if (gen === stagePreppedGen) stagePreppedLoading = false;
    // No asset, or this run was superseded/cancelled while it loaded. Drop the
    // hold with it so a missing mp3 can never leave protection stuck on.
    if (!buf || gen !== stagePreppedGen) {
      if (gen === stagePreppedGen) stagePreppedHeld = false;
      notifyStagePrepped();
      return;
    }

    const master = c.createGain();
    master.gain.value = STAGE_PREPPED_VOLUME;
    master.connect(c.destination);

    // The run is the whole clip, bounded both ways (`stagePreppedRunSeconds`):
    // a clip shorter than the floor loops up to it (the >=10s floor survives a
    // re-trim), a clip longer than the ceiling is faded at it (a held run can
    // never become ten minutes of music behind the UI). Only a run that CUTS
    // the audio gets the fade tail — the installed song ends on its own.
    // killEngine's cancelAndHoldAtTime overrides all of this cleanly when an
    // UNHELD run is cancelled mid-play.
    const now = c.currentTime;
    const clip = buf.duration;
    const seconds = stagePreppedRunSeconds(clip);
    const loops = clip < seconds;
    if (loops || clip > seconds) {
      const fade = Math.min(STAGE_PREPPED_FADE_TAIL, seconds / 2);
      master.gain.setValueAtTime(STAGE_PREPPED_VOLUME, now + seconds - fade);
      master.gain.linearRampToValueAtTime(0, now + seconds);
    }

    const src = c.createBufferSource();
    src.buffer = buf;
    src.loop = loops;
    src.connect(master);

    const run: EngineRun = { ctx: c, master, sources: [src] };
    engineRun = run;
    // Let go of the run once it has ended on its own, so a later stop can't
    // reach into finished nodes — and drop the hold with it, so protection
    // never outlives the sound it was protecting.
    src.onended = () => {
      if (engineRun === run) {
        engineRun = null;
        stagePreppedHeld = false;
      }
      try {
        master.disconnect();
      } catch {
        /* already detached by killEngine */
      }
      notifyStagePrepped();
    };
    src.start();
    // Hard stop at the boundary. A cut run is already faded to 0 by then and a
    // whole-song run has already ended, so this is silent — it exists so a
    // looping clip is bounded by the schedule, not by whoever remembers to stop.
    src.stop(now + seconds + 0.05);
    notifyStagePrepped();
  });
}

/**
 * Promote the running cue to HELD — call this when the operator CONFIRMS Start.
 * From here `stopStagePrepped()` is a no-op for this run, so the cue survives
 * the modal closing and plays the whole song. A later `playStagePrepped()` still
 * cuts it off (no layering), `releaseStagePrepped()` undoes it, and nothing here
 * is unbounded.
 */
export function holdStagePrepped(): void {
  stagePreppedHeld = true;
}

/**
 * Smoothly fade out + stop the stage-prepped cue — call when the "Preparing
 * Dispatch" modal closes so the engine doesn't keep running behind the UI.
 * Ramps down over ~450ms, then stops every source. Safe to call when nothing
 * is playing, and cancels a run whose audio is still loading.
 */
export function stopStagePrepped(fadeMs = 450): void {
  // A CONFIRMED run is protected — it ends on its own bounded schedule instead.
  // Only an unheld run (the modal was opened and then dismissed) is cut here.
  // The protection is scoped to a run that actually exists or is still loading:
  // a hold left over from a decode that failed cannot silence a later stop.
  if (stagePreppedHeld && (engineRun !== null || stagePreppedLoading)) return;
  stagePreppedHeld = false;
  stagePreppedGen += 1;
  // The in-flight load (if any) belongs to the generation just cancelled.
  stagePreppedLoading = false;
  killEngine(Math.max(0, fadeMs) / 1000);
  notifyStagePrepped();
}

/**
 * Undo `holdStagePrepped()` — call when the confirmed Start FAILED. The confirm
 * dialog stays open on a failure, so the run goes back to exactly its pre-confirm
 * state: Cancel kills it, a retried Confirm holds it again. Without this a
 * failed Start would leave the whole song playing, unstoppable, for a
 * processing run that never began.
 */
export function releaseStagePrepped(): void {
  stagePreppedHeld = false;
}

/* ── Peer side: the Start Processing broadcast ────────────────────────────
 * When a clerk starts processing, every OTHER open Payroll Wizard / Payment
 * Dispatch plays the same cue (Kane 2026-09-15). Those viewers clicked nothing,
 * so their AudioContext may be suspended and the browser will refuse audio.
 * ─────────────────────────────────────────────────────────────────────────── */

/** The armed one-shot unlock, if the peer’s browser refused the cue. */
let peerUnlock: (() => void) | null = null;

function disarmPeerUnlock(): void {
  if (!peerUnlock || typeof window === 'undefined') return;
  window.removeEventListener('pointerdown', peerUnlock);
  window.removeEventListener('keydown', peerUnlock);
  peerUnlock = null;
}

/**
 * Play the cue for someone who did NOT press the button.
 *
 * Resolves `true` when the sound is audible right now — which it is for anyone
 * who has clicked anywhere on the page since it loaded, i.e. nearly every real
 * spectator. Kane 2026-09-15: *"this should sound right away."*
 *
 * Resolves `false` when the browser refused it, having armed a ONE-SHOT unlock
 * on the next pointer/key. The caller must then show the affordance ("Tap
 * anywhere for sound") — a silent modal with no explanation is the failure this
 * return value exists to prevent.
 *
 * This is NOT a weakening of the never-`withCtx`-queued rule. `withCtx` parks a
 * cue on a module global indefinitely and fires it on the next unrelated click
 * anywhere in the app. This arm is owned by an open modal, is advertised on
 * screen, and MUST be torn down by `stopStagePreppedForPeer()` when that modal
 * closes — which is what keeps it an offer rather than an ambush. Precedent:
 * `src/lib/sound/carla-song.ts`.
 */
export async function playStagePreppedForPeer(): Promise<boolean> {
  const c = getCtx();
  if (!c) return false;
  // Never leave two arms live: a second broadcast supersedes the first.
  disarmPeerUnlock();

  if (c.state !== 'running') {
    try {
      await c.resume();
    } catch {
      /* autoplay policy refused — fall through to the armed path */
    }
  }

  const start = () => {
    playStagePrepped();
    // A peer has no confirm step, so the run is held immediately. It is still
    // bounded like every other run (`stagePreppedRunSeconds`), and
    // `stopStagePreppedForPeer()` can always cut it.
    holdStagePrepped();
  };

  if (c.state === 'running') {
    start();
    return true;
  }

  const fire = () => {
    disarmPeerUnlock();
    start();
  };
  peerUnlock = fire;
  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', fire);
    window.addEventListener('keydown', fire);
  }
  return false;
}

/**
 * Stop the peer cue and disarm any pending unlock — call on dismiss AND on
 * unmount. Dismissing the modal stops the song, the same contract the
 * operator’s Cancel already has.
 *
 * Clears the hold first: a peer run is held from the moment it starts, so a
 * plain `stopStagePrepped()` would be a no-op and the song would play on behind
 * a dismissed modal.
 */
export function stopStagePreppedForPeer(): void {
  disarmPeerUnlock();
  releaseStagePrepped();
  stopStagePrepped();
}

/** Sender cue: one soft, short blip — quiet so it never nags. */
export function playPingSent(): void {
  withCtx((c) => {
    const now = c.currentTime;
    const osc = c.createOscillator();
    const env = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, now);
    osc.frequency.exponentialRampToValueAtTime(990, now + 0.12);
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(0.06, now + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    osc.connect(env).connect(c.destination);
    osc.start(now);
    osc.stop(now + 0.2);
  });
}
