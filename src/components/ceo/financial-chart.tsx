'use client';

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from '@/lib/utils';

/* ──────────────────────────────────────────────────────────────────────────
 * PayoutTrendChart — a bespoke, dependency-free animated SVG line/area chart.
 *
 * The app ships no charting library (only motion/react), so this is hand-rolled
 * in the house style: a gradient area fill, a smooth Catmull-Rom line, a
 * left→right wipe reveal on mount, an interactive hover crosshair with an HTML
 * tooltip, and a selectable/highlighted point. Width is measured from the
 * container (ResizeObserver) so it stays crisp and responsive without distorting
 * strokes.
 * ────────────────────────────────────────────────────────────────────────── */

export interface ChartPoint {
  /** Short x-axis label, e.g. "Apr 12". */
  label: string;
  /** Longer label used in the tooltip, e.g. "April 12-18, 2026". */
  fullLabel?: string;
  value: number;
}

type Accent = 'amber' | 'emerald' | 'sky' | 'violet' | 'rose';

/** Shared timing for the metric-switch MORPH (e.g. Payout → Hours). The line,
 *  area and dots all use this exact curve so they move in perfect lockstep —
 *  the dots stay glued to the line the whole way instead of drifting. */
const MORPH = { duration: 0.55, ease: [0.22, 1, 0.36, 1] as const };

const ACCENT: Record<Accent, { line: string; from: string; to: string; dot: string; text: string }> = {
  amber: { line: '#f59e0b', from: '#f59e0b', to: '#f59e0b', dot: '#d97706', text: 'text-amber-600 dark:text-amber-400' },
  emerald: { line: '#10b981', from: '#10b981', to: '#10b981', dot: '#059669', text: 'text-emerald-600 dark:text-emerald-400' },
  sky: { line: '#0ea5e9', from: '#0ea5e9', to: '#0ea5e9', dot: '#0284c7', text: 'text-sky-600 dark:text-sky-400' },
  violet: { line: '#8b5cf6', from: '#8b5cf6', to: '#8b5cf6', dot: '#7c3aed', text: 'text-violet-600 dark:text-violet-400' },
  rose: { line: '#f43f5e', from: '#f43f5e', to: '#f43f5e', dot: '#e11d48', text: 'text-rose-600 dark:text-rose-400' },
};

/** Catmull-Rom spline → cubic-bezier path `d`. Smooth without a dependency. */
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0]!.x} ${pts[0]!.y}`;
  let d = `M ${pts[0]!.x} ${pts[0]!.y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

function useMeasuredWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setW(Math.round(width));
    });
    ro.observe(el);
    setW(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function PayoutTrendChart({
  points,
  selectedIndex,
  onSelect,
  accent = 'amber',
  height = 260,
  formatValue,
  formatTooltip,
  yTicks = 4,
}: {
  points: ChartPoint[];
  selectedIndex: number | null;
  onSelect?: (index: number) => void;
  accent?: Accent;
  height?: number;
  formatValue: (v: number) => string;
  /** Full tooltip value string (defaults to formatValue). */
  formatTooltip?: (p: ChartPoint, index: number) => string;
  yTicks?: number;
}) {
  const [wrapRef, width] = useMeasuredWidth();
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);

  // Replay the left→right wipe ONLY when the number of points changes — i.e. on
  // first mount and on a granularity flip (weekly⇄monthly), where the path's
  // segment count actually changes and can't be interpolated. A metric switch
  // (Payout → Hours) keeps the same point count, so it skips the wipe and the
  // line/area/dots MORPH smoothly to the new shape instead (see the motion.paths
  // below, which animate their `d`).
  useEffect(() => {
    setRevealed(false);
    const t = setTimeout(() => setRevealed(true), 30);
    return () => clearTimeout(t);
  }, [points.length]);

  const padL = 52;
  const padR = 14;
  const padT = 16;
  const padB = 26;
  const plotW = Math.max(0, width - padL - padR);
  const plotH = Math.max(0, height - padT - padB);

  const values = points.map((p) => p.value);
  const rawMax = values.length ? Math.max(...values) : 0;
  const rawMin = Math.min(0, ...values); // baseline at 0 for payout-style data
  // Nice-ish max so gridlines land on round numbers.
  const niceMax = niceCeil(rawMax || 1);
  const domainMin = rawMin;
  const domainMax = niceMax;
  const span = domainMax - domainMin || 1;

  const xAt = (i: number) =>
    points.length <= 1 ? padL + plotW / 2 : padL + (i / (points.length - 1)) * plotW;
  const yAt = (v: number) => padT + plotH - ((v - domainMin) / span) * plotH;

  const pts = points.map((p, i) => ({ x: xAt(i), y: yAt(p.value) }));
  const linePath = smoothPath(pts);
  const areaPath =
    pts.length > 0
      ? `${linePath} L ${pts[pts.length - 1]!.x} ${padT + plotH} L ${pts[0]!.x} ${padT + plotH} Z`
      : '';

  const a = ACCENT[accent];
  const activeIdx = hoverIdx ?? selectedIndex;

  // Y gridlines / labels.
  const ticks = Array.from({ length: yTicks + 1 }, (_, i) => domainMin + (span * i) / yTicks);

  // Sparse x labels — always first + last + selected, plus evenly spaced others.
  const xLabelIdx = useMemo(() => {
    const n = points.length;
    if (n === 0) return new Set<number>();
    const want = Math.min(n, Math.max(3, Math.floor(plotW / 90)));
    const set = new Set<number>([0, n - 1]);
    for (let k = 1; k < want - 1; k++) set.add(Math.round((k / (want - 1)) * (n - 1)));
    if (selectedIndex != null) set.add(selectedIndex);
    return set;
  }, [points.length, plotW, selectedIndex]);

  function handleMove(e: React.MouseEvent<SVGRectElement>) {
    if (points.length === 0) return;
    const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const x = e.clientX - rect.left - padL;
    const ratio = plotW > 0 ? x / plotW : 0;
    const idx = Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1))));
    setHoverIdx(idx);
  }

  const tooltip =
    activeIdx != null && points[activeIdx]
      ? {
          idx: activeIdx,
          x: xAt(activeIdx),
          y: yAt(points[activeIdx]!.value),
          text: formatTooltip
            ? formatTooltip(points[activeIdx]!, activeIdx)
            : formatValue(points[activeIdx]!.value),
          label: points[activeIdx]!.fullLabel ?? points[activeIdx]!.label,
        }
      : null;

  return (
    <div ref={wrapRef} className="relative w-full select-none" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} className="overflow-visible">
          <defs>
            <linearGradient id={`grad-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={a.from} stopOpacity="0.28" />
              <stop offset="55%" stopColor={a.to} stopOpacity="0.08" />
              <stop offset="100%" stopColor={a.to} stopOpacity="0" />
            </linearGradient>
            <mask id={`wipe-${uid}`}>
              <motion.rect
                x={padL}
                y={0}
                height={height}
                fill="white"
                initial={{ width: 0 }}
                animate={{ width: revealed ? plotW + padR : 0 }}
                transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
              />
            </mask>
          </defs>

          {/* Y gridlines + labels */}
          {ticks.map((t, i) => {
            const y = yAt(t);
            return (
              <g key={i}>
                <line
                  x1={padL}
                  x2={width - padR}
                  y1={y}
                  y2={y}
                  className="stroke-zinc-200/70 dark:stroke-zinc-800/70"
                  strokeWidth={1}
                  strokeDasharray={i === 0 ? undefined : '3 4'}
                />
                <text
                  x={padL - 8}
                  y={y + 3}
                  textAnchor="end"
                  className="fill-zinc-400 text-[10px] tabular-nums dark:fill-zinc-500"
                >
                  {compact(t)}
                </text>
              </g>
            );
          })}

          {/* Area + line. The wipe mask reveals them on entrance; on a metric
              switch the `d` MORPHS to the new curve (same point count = same path
              structure = interpolatable). */}
          {pts.length > 0 && (
            <g mask={`url(#wipe-${uid})`}>
              <motion.path
                animate={{ d: areaPath }}
                transition={MORPH}
                fill={`url(#grad-${uid})`}
              />
              <motion.path
                animate={{ d: linePath }}
                transition={MORPH}
                fill="none"
                stroke={a.line}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          )}

          {/* X labels */}
          {points.map((p, i) =>
            xLabelIdx.has(i) ? (
              <text
                key={i}
                x={xAt(i)}
                y={height - 8}
                textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}
                className={cn(
                  'text-[10px] tabular-nums',
                  i === selectedIndex ? cn('font-semibold', a.text) : 'fill-zinc-400 dark:fill-zinc-500',
                )}
                fill={i === selectedIndex ? undefined : undefined}
              >
                {p.label}
              </text>
            ) : null,
          )}

          {/* Dots for every point — fade in (staggered) on entrance, then their
              `cy` MORPHS in lockstep with the line on a metric switch (same MORPH
              curve) so they never drift off the curve. */}
          {pts.map((p, i) => (
            <motion.circle
              key={i}
              cx={p.x}
              r={i === selectedIndex ? 4.5 : 2.5}
              className={i === selectedIndex ? '' : 'fill-white dark:fill-zinc-950'}
              fill={i === selectedIndex ? a.dot : undefined}
              stroke={a.line}
              strokeWidth={i === selectedIndex ? 2 : 1.5}
              initial={{ opacity: 0, cy: p.y }}
              animate={{ opacity: 1, cy: p.y }}
              transition={{
                cy: MORPH,
                opacity: { delay: 0.5 + Math.min(0.4, i * 0.012), duration: 0.3 },
              }}
            />
          ))}

          {/* Selected-point pulse ring — tracks the selected dot as it morphs. */}
          {selectedIndex != null && pts[selectedIndex] && (
            <motion.circle
              cx={pts[selectedIndex]!.x}
              initial={{ cy: pts[selectedIndex]!.y }}
              animate={{ cy: pts[selectedIndex]!.y }}
              transition={{ cy: MORPH }}
              r={7}
              fill="none"
              stroke={a.line}
              strokeOpacity={0.35}
              strokeWidth={1.5}
            >
              <animate attributeName="r" values="6;11;6" dur="2.4s" repeatCount="indefinite" />
              <animate attributeName="stroke-opacity" values="0.4;0;0.4" dur="2.4s" repeatCount="indefinite" />
            </motion.circle>
          )}

          {/* Hover crosshair */}
          {tooltip && (
            <g>
              <line
                x1={tooltip.x}
                x2={tooltip.x}
                y1={padT}
                y2={padT + plotH}
                stroke={a.line}
                strokeOpacity={0.4}
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              <circle cx={tooltip.x} cy={tooltip.y} r={5} fill={a.dot} stroke="white" strokeWidth={2} />
            </g>
          )}

          {/* Pointer capture overlay */}
          <rect
            x={padL}
            y={0}
            width={Math.max(0, plotW + padR)}
            height={height}
            fill="transparent"
            style={{ cursor: onSelect ? 'pointer' : 'crosshair' }}
            onMouseMove={handleMove}
            onMouseLeave={() => setHoverIdx(null)}
            onClick={() => {
              if (onSelect && hoverIdx != null) onSelect(hoverIdx);
            }}
          />
        </svg>
      )}

      {/* HTML tooltip — crisp text, positioned over the active point. */}
      <AnimatePresence>
        {tooltip && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.14 }}
            className="pointer-events-none absolute z-20 -translate-x-1/2 rounded-lg border border-zinc-200 bg-white/95 px-2.5 py-1.5 text-center shadow-lg backdrop-blur-sm dark:border-zinc-700 dark:bg-zinc-900/95"
            style={{
              left: Math.max(60, Math.min(width - 60, tooltip.x)),
              top: Math.max(0, tooltip.y - 52),
            }}
          >
            <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-400">
              {tooltip.label}
            </div>
            <div className={cn('text-[13px] font-semibold tabular-nums', a.text)}>{tooltip.text}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── tiny helpers ─────────────────────────────────────────────────────────── */

/** Round a max up to a "nice" value (1/2/2.5/5 × 10ⁿ) for tidy gridlines. */
function niceCeil(x: number): number {
  if (x <= 0) return 1;
  const exp = Math.floor(Math.log10(x));
  const base = Math.pow(10, exp);
  const f = x / base;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * base;
}

/** Compact axis label: 1.2M, 350k, 4.5k, 900. */
function compact(v: number): string {
  const n = Math.abs(v);
  if (n >= 1_000_000) return `${trim(v / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(v / 1_000)}k`;
  return `${Math.round(v)}`;
}
function trim(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}
