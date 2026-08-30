'use client';

/**
 * Synthesized "ping" sounds for the Accounting collaboration layer.
 *
 * Two tiny Web Audio cues — no binary asset is shipped:
 *   - `playPingChime()`  : a friendly rising 3-note sparkle, played on the
 *                          RECIPIENT's side when someone pings them.
 *   - `playPingSent()`   : a soft, short blip, played on the SENDER's side as
 *                          tactile "it went out" feedback.
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
 * "Stage prepped" cue = a Lamborghini V12 ignition, played when the clerk hits
 * Start Processing (Payroll Wizard AND Payment Dispatch — deliberately the same
 * cue for the same action). Synthesized, not an asset: no engine recording can
 * be licensed into the repo, and this keeps the sound-reference page's promise
 * that every cue is Web Audio.
 *
 * Three movements, ~4.8s total:
 *   1. starter motor — seven grinding turns
 *   2. ignition      — a sub thump as it catches
 *   3. V12           — flare to ~6,200 rpm, one throttle blip, settle to idle
 *
 * Fired from the confirm click (a user gesture) so autoplay policy allows it.
 * Deliberately NOT routed through `withCtx`: that queues a cue for the next
 * gesture, and a 4.8-second engine roar must never ambush someone on an
 * unrelated later click. A locked context just resumes and plays from the top.
 * ──────────────────────────────────────────────────────────────────────────── */

const STAGE_PREPPED_VOLUME = 0.7;

/**
 * Firing frequency of a V12 = rpm ÷ 10 (12 cylinders, two revolutions per
 * cycle). Every oscillator, filter and noise band is scaled off this one curve
 * so the whole engine stays locked together as it revs. 92 Hz ≈ 920 rpm idle;
 * 620 Hz ≈ 6,200 rpm on the flare.
 */
const REV_CURVE: ReadonlyArray<readonly [number, number]> = [
  [0.70, 18],   // catching
  [0.88, 130],  // caught — 1,300 rpm
  [1.08, 620],  // the flare — 6,200 rpm
  [1.50, 240],
  [1.74, 170],
  [2.02, 470],  // throttle blip
  [2.44, 155],
  [2.78, 112],
  [3.25, 96],
  [4.60, 92],   // idle
];

const ENGINE_END = 4.85;

/** Drive one AudioParam off the rev curve: `base + firingHz * scale`. */
function scheduleRev(param: AudioParam, scale: number, base: number, now: number): void {
  const [t0, v0] = REV_CURVE[0];
  param.setValueAtTime(base + v0 * scale, now + t0);
  for (let i = 1; i < REV_CURVE.length; i += 1) {
    const [t, v] = REV_CURVE[i];
    param.linearRampToValueAtTime(base + v * scale, now + t);
  }
}

let noiseBuf: AudioBuffer | null = null;
function getNoise(c: AudioContext): AudioBuffer {
  if (!noiseBuf || noiseBuf.sampleRate !== c.sampleRate) {
    const len = Math.floor(c.sampleRate * 2);
    noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
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

export function playStagePrepped(): void {
  const c = getCtx();
  if (!c) return;
  // Rapid re-trigger: snap the previous run off with a click-free 60ms fade
  // rather than layering a second engine on top of the first.
  killEngine(0.06);
  if (c.state !== 'running') void c.resume().catch(() => {});

  const now = c.currentTime + 0.02;
  const sources: AudioScheduledSourceNode[] = [];

  // Master bus → compressor, which glues the crank, thump and V12 into one
  // body and keeps the flare from clipping.
  const master = c.createGain();
  master.gain.value = STAGE_PREPPED_VOLUME;
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.knee.value = 24;
  comp.ratio.value = 6;
  comp.attack.value = 0.004;
  comp.release.value = 0.18;
  master.connect(comp).connect(c.destination);

  // ── 1. Starter motor ──────────────────────────────────────────────────────
  const crankGain = c.createGain();
  crankGain.gain.value = 0;
  const crankTone = c.createBiquadFilter();
  crankTone.type = 'lowpass';
  crankTone.frequency.value = 900;
  crankGain.connect(crankTone).connect(master);

  const crankOsc = c.createOscillator();
  crankOsc.type = 'sawtooth';
  crankOsc.frequency.setValueAtTime(42, now);
  crankOsc.frequency.linearRampToValueAtTime(68, now + 0.78);
  crankOsc.connect(crankGain);

  const crankNoise = c.createBufferSource();
  crankNoise.buffer = getNoise(c);
  crankNoise.loop = true;
  const crankNoiseGain = c.createGain();
  crankNoiseGain.gain.value = 0.5;
  crankNoise.connect(crankNoiseGain).connect(crankGain);

  const TURNS = 7;
  const TURN = 0.112;
  for (let i = 0; i < TURNS; i += 1) {
    const t = now + i * TURN;
    crankGain.gain.setValueAtTime(0.02, t);
    crankGain.gain.linearRampToValueAtTime(0.42, t + 0.026);
    crankGain.gain.exponentialRampToValueAtTime(0.03, t + TURN * 0.82);
  }
  crankGain.gain.linearRampToValueAtTime(0, now + TURNS * TURN + 0.08);
  for (const src of [crankOsc, crankNoise] as AudioScheduledSourceNode[]) {
    src.start(now);
    src.stop(now + TURNS * TURN + 0.2);
    sources.push(src);
  }

  // ── 2. Ignition thump — the whump as it catches ───────────────────────────
  const thump = c.createOscillator();
  thump.type = 'sine';
  thump.frequency.setValueAtTime(160, now + 0.78);
  thump.frequency.exponentialRampToValueAtTime(42, now + 0.98);
  const thumpEnv = c.createGain();
  thumpEnv.gain.setValueAtTime(0, now + 0.78);
  thumpEnv.gain.linearRampToValueAtTime(0.5, now + 0.8);
  thumpEnv.gain.exponentialRampToValueAtTime(0.0001, now + 1.05);
  thump.connect(thumpEnv).connect(master);
  thump.start(now + 0.78);
  thump.stop(now + 1.1);
  sources.push(thump);

  // ── 3. The V12 ────────────────────────────────────────────────────────────
  const engineGain = c.createGain();
  engineGain.gain.setValueAtTime(0, now + 0.72);
  engineGain.gain.linearRampToValueAtTime(0.95, now + 0.92);
  engineGain.gain.setValueAtTime(0.95, now + 3.9);
  engineGain.gain.linearRampToValueAtTime(0, now + ENGINE_END - 0.1);

  // Cutoff tracks revs, so it snarls open on the flare and darkens at idle.
  const engineTone = c.createBiquadFilter();
  engineTone.type = 'lowpass';
  engineTone.Q.value = 0.9;
  scheduleRev(engineTone.frequency, 5.2, 260, now);
  engineGain.connect(engineTone).connect(master);

  // [harmonic of the firing frequency, gain, waveform, detune cents]
  const HARMONICS: ReadonlyArray<readonly [number, number, OscillatorType, number]> = [
    [0.5, 0.13, 'sawtooth', 0],   // half-order lope — the V-angle beat
    [1, 0.3, 'sawtooth', -7],     // fundamental, detuned pair for thickness
    [1, 0.22, 'sawtooth', 7],
    [2, 0.17, 'sawtooth', 0],
    [3, 0.09, 'square', 0],
    [4, 0.05, 'sawtooth', 0],
  ];
  for (const [mult, gain, type, detune] of HARMONICS) {
    const osc = c.createOscillator();
    osc.type = type;
    osc.detune.value = detune;
    scheduleRev(osc.frequency, mult, 0, now);
    const g = c.createGain();
    g.gain.value = gain;
    osc.connect(g).connect(engineGain);
    osc.start(now + 0.7);
    osc.stop(now + ENGINE_END);
    sources.push(osc);
  }

  // Induction / exhaust rasp: noise through a band that rides the revs.
  const rasp = c.createBufferSource();
  rasp.buffer = getNoise(c);
  rasp.loop = true;
  const raspBand = c.createBiquadFilter();
  raspBand.type = 'bandpass';
  raspBand.Q.value = 1.1;
  scheduleRev(raspBand.frequency, 3.4, 420, now);
  const raspGain = c.createGain();
  raspGain.gain.value = 0;
  scheduleRev(raspGain.gain, 0.00035, 0.01, now);
  rasp.connect(raspBand).connect(raspGain).connect(engineGain);
  rasp.start(now + 0.7);
  rasp.stop(now + ENGINE_END);
  sources.push(rasp);

  const run: EngineRun = { ctx: c, master, sources };
  engineRun = run;
  // Let go of the run once it has ended on its own, so a later stop can't
  // reach into finished nodes.
  window.setTimeout(
    () => {
      if (engineRun === run) engineRun = null;
    },
    (ENGINE_END + 0.3) * 1000,
  );
}

/**
 * Smoothly fade out + stop the stage-prepped cue — call when the "Preparing
 * Dispatch" modal closes so the engine doesn't keep running behind the UI.
 * Ramps down over ~450ms, then stops every source. Safe to call when nothing
 * is playing.
 */
export function stopStagePrepped(fadeMs = 450): void {
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
