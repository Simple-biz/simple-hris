'use client';

import React from 'react';
import { cn } from '@/lib/utils';

/**
 * The Total Payout hero figure as a slot-machine odometer, and its loading state.
 *
 * Extracted from the Accounting dashboard (`Overview.tsx`) on 2026-10-02 so the
 * CEO Overview hero loads the way Accounting's does — the reels spin in place
 * of the number, the frame is already on screen — rather than behind a
 * full-page skeleton. Same precedent as `hero-stat-row.tsx`: one rendered
 * component for both dashboards, never a fork. The CSS it drives
 * (`payout-reel-*`) lives in `src/index.css`.
 */

// Reel geometry. A hidden ghost "0" inside each reel gives the inline-block its
// normal text baseline, so the visible reel never floats off the line (the fix
// for the "numbers floating" bug). The strip's cells share that exact font /
// line box, so translateY(-N em) lands digit N dead on the baseline. Window and
// cell are both a clean 1em with line-height 1 — no tall-cell / negative-margin
// hacks, no doubled-digit clipping. Width leaves room for a bold mono glyph.
const REEL_WIDTH_EM = 0.62; // per-digit horizontal room

type ReelPhase = 'spinning' | 'settling' | 'rest';

/**
 * DigitReel — one vertical 0-9 strip driven by translateY.
 *  - phase "spinning": the CSS `payout-reel-spin` loop runs it continuously with
 *    a motion blur — this IS the loading indicator.
 *  - phase "settling": a JS transition decelerates the strip onto `digit`, then
 *    a one-shot warm flash marks the lock-in.
 *  - phase "rest": parked on `digit`, static.
 * Reduced motion snaps straight to the digit with no spin, blur, or flash.
 */
function DigitReel({
  digit,
  phase,
  delayMs,
  reduce,
}: {
  digit: number;
  phase: ReelPhase;
  delayMs: number;
  reduce: boolean;
}) {
  const target = Math.min(9, Math.max(0, digit));

  // Extra full turns folded into the settle travel so the deceleration reads as
  // a wheel spinning down rather than a short hop.
  const TURNS = 4;
  // Resting offset depends on how many 0-9 bands the strip renders in this
  // phase. Settling renders TURNS+1 bands (the target lives in the LAST band, so
  // the reel spins through every turn before landing). Rest / reduced-motion
  // render a single band, so the target is simply -target. Using the 49-index
  // offset against a single-band strip scrolls past the end → a blank reel.
  const restOffsetEm = phase === 'settling' ? -(TURNS * 10 + target) : -target;

  const [flash, setFlash] = React.useState(false);
  const [settleOffsetEm, setSettleOffsetEm] = React.useState(0);
  const rafRef = React.useRef(0);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Drive the settle: on entering "settling", kick a transition from the top of
  // the strip down to the target, and flash when it lands. Reduced motion or a
  // direct "rest" mount parks immediately.
  React.useEffect(() => {
    if (reduce) {
      setSettleOffsetEm(restOffsetEm);
      setFlash(false);
      return;
    }
    if (phase === 'rest') {
      setSettleOffsetEm(restOffsetEm);
      return;
    }
    if (phase !== 'settling') return;
    setSettleOffsetEm(0);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = requestAnimationFrame(() => setSettleOffsetEm(restOffsetEm));
    });
    const SETTLE_MS = 1000;
    timerRef.current = setTimeout(() => setFlash(true), delayMs + SETTLE_MS);
    return () => {
      cancelAnimationFrame(rafRef.current);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, digit, reduce, delayMs]);

  // The strip only needs the extra pre-roll bands during a settle; at rest one
  // 0-9 band is enough, and the spinning loop cycles a single band. When
  // spinning, append a trailing "0" so the keyframe (0 → -10em) wraps seamlessly
  // — the 11th cell shows the same glyph the loop restarts on.
  const strips = phase === 'settling' ? TURNS + 1 : 1;
  const cells = React.useMemo(() => {
    const arr: number[] = [];
    for (let t = 0; t < strips; t += 1) for (let d = 0; d <= 9; d += 1) arr.push(d);
    if (phase === 'spinning') arr.push(0); // seamless wrap cell
    return arr;
  }, [strips, phase]);

  const spinning = phase === 'spinning' && !reduce;
  // Fade the reel edges only while it's in motion: the whole time it spins, and
  // during the settle up until the moment it locks in (flash). Off at rest and
  // under reduced motion, so the final digit shows in full.
  const masked = !reduce && (spinning || (phase === 'settling' && !flash));

  return (
    <span
      className={cn(
        'relative inline-block overflow-hidden align-baseline',
        masked && 'payout-reel-masked',
      )}
      style={{ width: `${REEL_WIDTH_EM}em`, height: '1em' }}
      aria-hidden
    >
      {/* Ghost reserves the inline baseline + box so the reel sits on the line. */}
      <span className="invisible" aria-hidden>
        0
      </span>
      <span
        className={cn(
          'absolute left-0 top-0 flex flex-col',
          spinning && 'payout-reel-spinning',
          flash && 'payout-reel-settle',
        )}
        style={{
          // Each reel spins at a slightly different rate so the wheels look
          // independent rather than a single sliding block. Keyed off delayMs.
          ['--reel-spin-dur' as string]: `${0.42 + (delayMs % 5) * 0.03}s`,
          // While spinning the CSS keyframe owns transform; otherwise we drive it.
          transform: spinning ? undefined : `translateY(${settleOffsetEm}em)`,
          transition:
            phase === 'settling' && !reduce
              ? `transform 1000ms cubic-bezier(0.12, 0.8, 0.15, 1) ${delayMs}ms`
              : 'none',
          willChange: 'transform',
        }}
      >
        {cells.map((d, i) => (
          <span
            key={i}
            className="flex h-[1em] items-center justify-center leading-none"
          >
            {d}
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * RollingPayout — the Total Payout hero figure as a slot-machine odometer.
 *
 * While `loading`, a fixed set of reels spins continuously (blurred), so the
 * reels themselves ARE the loading state — no separate skeleton. When the value
 * arrives, the reels swap to the real digits and settle left-to-right (most-
 * significant digit lands last) so the eye reads it counting into place. A
 * later value change re-runs the settle. Snaps instantly under reduced motion,
 * and a plain-text mirror carries the real number to assistive tech.
 */
export function RollingPayout({
  value,
  loading,
}: {
  value: number | null;
  loading: boolean;
}) {
  const reduce =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const formatted =
    value != null
      ? value.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : null;

  // Phase machine. Loading (or no value yet) → free spin. Once the value is
  // known and loading clears, run one settle, then rest. A new value re-settles.
  const [phase, setPhase] = React.useState<ReelPhase>(loading || formatted == null ? 'spinning' : 'settling');
  const prevFmtRef = React.useRef<string | null>(null);
  const restTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    if (loading || formatted == null) {
      setPhase('spinning');
      prevFmtRef.current = null;
      return;
    }
    // Value is ready. If it changed (or we were spinning), settle onto it.
    if (prevFmtRef.current !== formatted) {
      prevFmtRef.current = formatted;
      setPhase('settling');
      if (restTimerRef.current) clearTimeout(restTimerRef.current);
      // After the last reel lands, drop to a cheap static rest.
      const lastDelay = (formatted.replace(/\D/g, '').length - 1) * 90;
      restTimerRef.current = setTimeout(() => setPhase('rest'), lastDelay + 1400);
    }
    return () => {
      if (restTimerRef.current) clearTimeout(restTimerRef.current);
    };
  }, [loading, formatted]);

  // Loading placeholder: a plausible number of reels + separators so the layout
  // (and the spin) matches the real figure's footprint. Not the real value.
  const template = formatted ?? '0,000,000.00';

  // Left-to-right settle: each successive DIGIT lands a beat after the previous.
  const STEP_MS = 90;
  let digitOrdinal = -1;

  return (
    <span className="relative inline-flex items-baseline font-mono font-bold tabular-nums">
      {/* Screen-reader-only true value; the reels are aria-hidden. */}
      <span className="sr-only">{formatted != null ? `₱${formatted}` : 'Loading total payout'}</span>
      <span aria-hidden className="inline-flex items-baseline">
        {template.split('').map((ch, i) => {
          if (ch >= '0' && ch <= '9') {
            digitOrdinal += 1;
            return (
              <DigitReel
                // Remount on phase change so each phase starts from a clean
                // state (no CSS-anim → JS-transform hand-off glitch).
                key={`${phase}-${i}`}
                digit={Number(ch)}
                phase={phase}
                reduce={reduce}
                delayMs={digitOrdinal * STEP_MS}
              />
            );
          }
          return (
            <span key={`sep-${i}`} className="inline-block px-[0.02em]">
              {ch}
            </span>
          );
        })}
      </span>
    </span>
  );
}
