'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';

/* ──────────────────────────────────────────────────────────────────────────
 * Transfer charts — bespoke, dependency-free SVG in the app's house style
 * (see ceo/financial-chart.tsx). The app ships no charting library, so these
 * are hand-rolled: measured width via ResizeObserver, an entrance reveal that
 * respects prefers-reduced-motion, and light/dark tuning throughout.
 *
 *   • StatusDonut   — the transfer pipeline as a single ring (Awaiting →
 *                     Scheduled → Applied → Declined), with the live total in
 *                     the hole. Answers "where does my team's work stand?".
 *   • FlowBars      — the busiest department routes as horizontal bars.
 *                     Answers "which teams am I trading people with?".
 *
 * The week-by-week trend reuses the shared PayoutTrendChart directly.
 * ────────────────────────────────────────────────────────────────────────── */

function useMeasuredWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      setW(Math.round(entries[0]?.contentRect.width ?? 0));
    });
    ro.observe(el);
    setW(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// ── Status donut ────────────────────────────────────────────────────────────

export interface DonutSegment {
  key: string;
  label: string;
  value: number;
  /** Solid hex for the arc (works identically in both themes). */
  color: string;
}

/**
 * A single-ring donut of the transfer pipeline. Segments sweep in on mount
 * (skipped under reduced motion), the hovered segment lifts its stroke, and the
 * hole carries the total plus the active segment's read-out. Renders an
 * all-neutral placeholder ring when every value is zero so the panel never
 * collapses to empty space.
 */
export function StatusDonut({
  segments,
  size = 168,
  thickness = 20,
  centerLabel = 'transfers',
}: {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
}) {
  const reduce = useReducedMotion();
  const [active, setActive] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (reduce) {
      setRevealed(true);
      return;
    }
    setRevealed(false);
    const t = setTimeout(() => setRevealed(true), 40);
    return () => clearTimeout(t);
  }, [reduce]);

  const total = segments.reduce((s, seg) => s + seg.value, 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const cx = size / 2;
  const cy = size / 2;

  // Lay each segment out as a dash offset around the ring. A 1.5° gap between
  // non-zero segments keeps the colors from bleeding into one another.
  const GAP_DEG = total > 0 ? 1.5 : 0;
  let cursorDeg = -90; // start at 12 o'clock
  const arcs = segments.map((seg) => {
    const frac = total > 0 ? seg.value / total : 0;
    const sweep = frac * 360 - (frac > 0 ? GAP_DEG : 0);
    const start = cursorDeg + (frac > 0 ? GAP_DEG / 2 : 0);
    cursorDeg += frac * 360;
    return { seg, sweep: Math.max(0, sweep), startDeg: start, frac };
  });

  const activeSeg = active != null ? segments[active] : null;
  const headline = activeSeg ? activeSeg.value : total;
  const headlineLabel = activeSeg ? activeSeg.label : centerLabel;

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="-rotate-90"
          role="img"
          aria-label={`Transfer pipeline: ${segments.map((s) => `${s.value} ${s.label}`).join(', ')}`}
        >
          {/* Track */}
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            strokeWidth={thickness}
            className="stroke-zinc-100 dark:stroke-zinc-800/70"
          />
          {total === 0 ? (
            <circle
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              strokeWidth={thickness}
              strokeLinecap="round"
              className="stroke-zinc-200 dark:stroke-zinc-800"
              strokeDasharray="2 10"
            />
          ) : (
            arcs.map(({ seg, sweep, startDeg, frac }, i) => {
              if (frac <= 0) return null;
              const dash = (sweep / 360) * c;
              const offset = (startDeg / 360) * c;
              const isActive = active === i;
              // Grow the arc by animating its OWN dash length from 0 → dash (the
              // gap fills the rest of the circle). This is self-consistent in px,
              // so it never fights the offset math the way `pathLength` would.
              return (
                <motion.circle
                  key={seg.key}
                  cx={cx}
                  cy={cy}
                  r={r}
                  fill="none"
                  stroke={seg.color}
                  strokeWidth={isActive ? thickness + 4 : thickness}
                  strokeLinecap="butt"
                  style={{ strokeDashoffset: -offset }}
                  initial={reduce ? { strokeDasharray: `${dash} ${c - dash}` } : { strokeDasharray: `0 ${c}` }}
                  animate={{ strokeDasharray: revealed ? `${dash} ${c - dash}` : `0 ${c}` }}
                  transition={{
                    strokeDasharray: { duration: 0.7, ease: [0.22, 1, 0.36, 1], delay: i * 0.08 },
                    strokeWidth: { duration: 0.18 },
                  }}
                  onMouseEnter={() => setActive(i)}
                  onMouseLeave={() => setActive((cur) => (cur === i ? null : cur))}
                  className="cursor-default"
                />
              );
            })
          )}
        </svg>
        {/* Hole read-out */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-bold leading-none tabular-nums text-zinc-900 dark:text-white">
            {headline}
          </span>
          <span className="mt-1 max-w-[7rem] text-center text-[11px] font-medium leading-tight text-zinc-500 dark:text-zinc-400">
            {headlineLabel}
          </span>
        </div>
      </div>

      {/* Legend — interactive, mirrors hover with the ring. One row per segment
          below the donut (reads cleanly whether the panel is wide or narrow). */}
      <ul className="grid w-full grid-cols-1 gap-x-4 gap-y-2 min-[420px]:grid-cols-2 xl:grid-cols-1">
        {segments.map((seg, i) => {
          const pct = total > 0 ? Math.round((seg.value / total) * 100) : 0;
          return (
            <li key={seg.key}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onMouseLeave={() => setActive((cur) => (cur === i ? null : cur))}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors',
                  active === i ? 'bg-zinc-100 dark:bg-zinc-800/60' : 'hover:bg-zinc-50 dark:hover:bg-zinc-900/60',
                )}
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: seg.color }}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-zinc-600 dark:text-zinc-300">
                  {seg.label}
                </span>
                <span className="shrink-0 text-[12px] font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                  {seg.value}
                </span>
                <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-zinc-400 dark:text-zinc-500">
                  {pct}%
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── Flow bars ─────────────────────────────────────────────────────────────

export interface FlowRow {
  from: string;
  to: string;
  count: number;
}

/**
 * The busiest department routes as horizontal bars, longest first. Each bar
 * grows from the left on mount (skipped under reduced motion). Widths are
 * measured so labels never clip, and the "from → to" pair reads inline.
 */
export function FlowBars({ rows, max = 5 }: { rows: FlowRow[]; max?: number }) {
  const reduce = useReducedMotion();
  const [wrapRef] = useMeasuredWidth();
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (reduce) {
      setRevealed(true);
      return;
    }
    setRevealed(false);
    const t = setTimeout(() => setRevealed(true), 40);
    return () => clearTimeout(t);
  }, [reduce]);

  const top = rows.slice(0, max);
  const peak = top.reduce((m, r) => Math.max(m, r.count), 0) || 1;

  if (top.length === 0) {
    return (
      <div className="flex h-full min-h-[7rem] items-center justify-center rounded-xl border border-dashed border-zinc-200 text-center text-[12px] text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
        No completed moves to chart yet.
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="flex flex-col gap-2.5">
      {top.map((row, i) => {
        const frac = row.count / peak;
        return (
          <div key={`${row.from}→${row.to}-${uid}-${i}`} className="group">
            <div className="mb-1 flex items-center justify-between gap-2 text-[12px]">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-medium text-zinc-600 dark:text-zinc-300">{row.from}</span>
                <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0 text-zinc-400" aria-hidden fill="none">
                  <path d="M3 8h9M9 4.5L12.5 8 9 11.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="truncate font-semibold text-zinc-800 dark:text-zinc-100">{row.to}</span>
              </span>
              <span className="shrink-0 tabular-nums font-semibold text-blue-600 dark:text-blue-300">
                {row.count}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800/70">
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-blue-500 to-sky-400 dark:from-blue-500 dark:to-sky-500"
                initial={reduce ? { width: `${frac * 100}%` } : { width: 0 }}
                animate={{ width: revealed ? `${frac * 100}%` : 0 }}
                transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1], delay: i * 0.06 }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
