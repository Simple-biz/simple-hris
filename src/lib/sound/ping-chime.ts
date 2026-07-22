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
