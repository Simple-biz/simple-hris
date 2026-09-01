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
 * (`public/sounds/truckstart.mp3`) rather than a synthesized sound.
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
 * "Stage prepped" cue = a truck engine start, played when the clerk hits
 * Start Processing (Payroll Wizard AND Payment Dispatch — deliberately the same
 * cue for the same action). Plays the Kane-supplied recording at
 * `public/sounds/truckstart.mp3` (replaced the synthesized Lamborghini V12,
 * 2026-09-01 — committed audio assets follow the carla-song precedent). If the
 * asset is missing or fails to decode the cue is a silent no-op.
 *
 * Fired from the confirm click (a user gesture) so autoplay policy allows it.
 * Deliberately NOT routed through `withCtx`: that queues a cue for the next
 * gesture, and an engine roar must never ambush someone on an unrelated later
 * click. A locked context just resumes and plays from the top.
 * ──────────────────────────────────────────────────────────────────────────── */

const STAGE_PREPPED_VOLUME = 0.7;
const STAGE_PREPPED_SRC = '/sounds/truckstart.mp3';
// Ramp the tail down instead of letting the recording end cold. Clamped to
// half the clip so a short asset never fades from the very start.
const STAGE_PREPPED_FADE_TAIL = 1.2;

/**
 * Decoded once and cached; a failed fetch/decode resolves null (silent no-op)
 * and clears the cache so the next click can retry.
 */
let stagePreppedBuf: Promise<AudioBuffer | null> | null = null;
function loadStagePrepped(c: AudioContext): Promise<AudioBuffer | null> {
  if (!stagePreppedBuf) {
    stagePreppedBuf = fetch(STAGE_PREPPED_SRC)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((bytes) => c.decodeAudioData(bytes))
      .catch(() => {
        stagePreppedBuf = null;
        return null;
      });
  }
  return stagePreppedBuf;
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

export function playStagePrepped(): void {
  const c = getCtx();
  if (!c) return;
  // Rapid re-trigger: snap the previous run off with a click-free 60ms fade
  // rather than layering a second engine on top of the first.
  killEngine(0.06);
  if (c.state !== 'running') void c.resume().catch(() => {});

  const gen = ++stagePreppedGen;
  void loadStagePrepped(c).then((buf) => {
    if (!buf || gen !== stagePreppedGen) return;

    const master = c.createGain();
    master.gain.value = STAGE_PREPPED_VOLUME;
    master.connect(c.destination);

    // Natural-end fade-out over the clip's last STAGE_PREPPED_FADE_TAIL
    // seconds. killEngine's cancelAndHoldAtTime overrides this cleanly when
    // the modal closes mid-play.
    const now = c.currentTime;
    const fade = Math.min(STAGE_PREPPED_FADE_TAIL, buf.duration / 2);
    master.gain.setValueAtTime(STAGE_PREPPED_VOLUME, now + buf.duration - fade);
    master.gain.linearRampToValueAtTime(0, now + buf.duration);

    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(master);

    const run: EngineRun = { ctx: c, master, sources: [src] };
    engineRun = run;
    // Let go of the run once it has ended on its own, so a later stop can't
    // reach into finished nodes.
    src.onended = () => {
      if (engineRun === run) engineRun = null;
      try {
        master.disconnect();
      } catch {
        /* already detached by killEngine */
      }
    };
    src.start();
  });
}

/**
 * Smoothly fade out + stop the stage-prepped cue — call when the "Preparing
 * Dispatch" modal closes so the engine doesn't keep running behind the UI.
 * Ramps down over ~450ms, then stops every source. Safe to call when nothing
 * is playing, and cancels a run whose audio is still loading.
 */
export function stopStagePrepped(fadeMs = 450): void {
  stagePreppedGen += 1;
  killEngine(Math.max(0, fadeMs) / 1000);
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
