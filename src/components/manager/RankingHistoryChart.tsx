'use client';

/**
 * The two line charts inside My Team → Rankings → **View**
 * (`docs/features/manager-rankings-history.md`): **KPI performance** (the person's
 * count each settled week, against the team's weekly average) above **Ranking
 * performance** (their position each week, #1 at the top).
 *
 * Drawn the way `CycleTrendChart` (`src/components/admin/performance-ui.tsx`) is, and
 * kept local for the same reason that chart keeps its own copy:
 *
 * - **Two strips on one x axis, never two y-axes.** A count and a position share no
 *   scale; one plot with two axes would invent a correlation.
 * - **The line breaks; it never interpolates.** A week with no entry has no point and
 *   no segment into or out of it. No entry ≠ 0 (`manager-pm-rankings.md`), so bridging
 *   the gap, or dropping it to zero, would assert a week nobody recorded.
 * - **Straight segments, never a spline.** A curve would overshoot between weeks.
 * - **Measured, not scaled:** real pixel coordinates, so a stroke never thins out.
 * - **Colours were validated, not chosen** (dataviz validator, 2026-09-28): the person's
 *   line is `blue-600` on light (#2563eb) and `blue-500` on dark (#3b82f6), both
 *   passing the lightness band, contrast and CVD checks. The team average is
 *   `zinc-500` (#71717a), deliberately under the chroma floor: it is the grey context
 *   line behind the one series that matters (emphasis), and it is never the only way to
 *   tell the two apart — the legend, the tooltip rows and the table below carry names.
 * - **Lines only, no area wash.** Two series share the KPI strip, and a wash under one
 *   would bury the other (dataviz: an area is for a single series).
 * - Gridlines are solid hairlines. Text wears text tokens, never the series colour.
 * - **Opens on the newest week.** On a phone the history is wider than the screen, so
 *   the scroller starts at its right end: the latest weeks are the ones asked about.
 */
import * as React from 'react';
import { useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';
import type { HistoryPoint } from '@/lib/manager/ranking-history';
import { addDaysIso, dateLabel, fmtCount } from '@/components/manager/leaderboard-ui';

/** Each week's horizontal slot. The plot stretches past this on a wide screen. */
const MIN_SLOT_PX = 36;
const KPI_H = 132;
const RANK_H = 104;
/** The label row between the two strips. */
const MID_H = 30;
const AXIS_H = 18;
/** Vertical inset, so a marker (r 4 + its 2px ring) and its label never clip. */
const PAD = 14;

const EASE_CSS = 'cubic-bezier(0.22, 1, 0.36, 1)';

function useMeasuredWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = React.useRef<HTMLDivElement>(null);
  const [w, setW] = React.useState(0);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setW(entry.contentRect.width);
    });
    ro.observe(el);
    setW(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

type Pt = { x: number; y: number; i: number };

/** Consecutive weeks that all carry a value — one unbroken segment each. */
function toRuns(values: readonly (number | null)[], x: (i: number) => number, y: (v: number) => number): Pt[][] {
  const runs: Pt[][] = [];
  let cur: Pt[] = [];
  values.forEach((v, i) => {
    if (v == null) {
      if (cur.length) runs.push(cur);
      cur = [];
      return;
    }
    cur.push({ x: x(i), y: y(v), i });
  });
  if (cur.length) runs.push(cur);
  return runs;
}

const linePath = (pts: Pt[]): string => pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

/** A clean ceiling for a zero-based count axis: 1 · 2 · 2.5 · 5 × 10ⁿ. */
function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v - 1e-9) return m * p;
  return 10 * p;
}

function tick(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function weekRangeLabel(periodStart: string): string {
  return `${dateLabel(periodStart, false)} – ${dateLabel(addDaysIso(periodStart, 6), false)}`;
}

/** The sentence a week reads as — the tooltip's content, for screen readers too. */
function pointSentence(p: HistoryPoint, o: { showValues: boolean; rankPending: boolean; unit: string }): string {
  const parts = [weekRangeLabel(p.periodStart)];
  if (o.showValues) {
    parts.push(p.value === null ? 'no entry' : `${fmtCount(p.value)} ${o.unit}`);
    if (p.teamAverage !== null) parts.push(`team average ${p.teamAverage.toFixed(1)}`);
  }
  if (o.rankPending) parts.push('rank loading');
  else if (p.position !== null) parts.push(`rank ${p.position} of ${p.ranked}`);
  else parts.push(p.value === null && !o.showValues ? 'not ranked, no entry' : 'not ranked');
  return parts.join(', ');
}

export function RankingHistoryChart({
  points,
  showValues,
  rankPending,
  personLabel,
  unitLabel,
  partLabels,
}: {
  /** Oldest first. */
  points: readonly HistoryPoint[];
  /** False = order-only: the KPI strip is not drawn at all (the value is the pesos). */
  showValues: boolean;
  rankPending: boolean;
  /** The person, as the legend names them (first name). */
  personLabel: string;
  /** What a value counts, plural ("appointments", "KPI items", "Tickets completed"). */
  unitLabel: string;
  partLabels?: Readonly<Record<string, string>>;
}) {
  const reduce = useReducedMotion() ?? false;
  const [wrapRef, measured] = useMeasuredWidth();
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const [hover, setHover] = React.useState<number | null>(null);
  const [revealed, setRevealed] = React.useState(reduce);
  const liveId = React.useId();

  // Draw on AFTER the dialog has scaled in (320ms), so the reveal is seen, not missed.
  React.useEffect(() => {
    if (reduce) return;
    const t = window.setTimeout(() => setRevealed(true), 160);
    return () => window.clearTimeout(t);
  }, [reduce]);

  const n = points.length;
  const plotW = Math.max(measured, n * MIN_SLOT_PX);

  // Start at the newest week whenever the history is wider than its box.
  React.useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el && el.scrollWidth > el.clientWidth) el.scrollLeft = el.scrollWidth;
  }, [plotW]);
  const slot = n > 0 ? plotW / n : 0;
  const xAt = (i: number) => slot * (i + 0.5);

  const values = points.map((p) => p.value);
  const averages = points.map((p) => p.teamAverage);
  const kpiMax = niceCeil(Math.max(0, ...values.map((v) => v ?? 0), ...averages.map((v) => v ?? 0)));
  const kpiY = (v: number) => KPI_H - PAD - (v / kpiMax) * (KPI_H - 2 * PAD);

  const positions = rankPending ? points.map(() => null) : points.map((p) => p.position);
  const rankMax = Math.max(1, ...points.map((p) => p.ranked), ...positions.map((v) => v ?? 1));
  const rankY = (pos: number) => (rankMax <= 1 ? PAD : PAD + ((pos - 1) / (rankMax - 1)) * (RANK_H - 2 * PAD));

  const personRuns = toRuns(values, xAt, kpiY);
  const averageRuns = toRuns(averages, xAt, kpiY);
  const rankRuns = toRuns(positions, xAt, rankY);

  // Selective direct labels: the newest week and the best one. Never every point.
  const labelled = (series: readonly (number | null)[], best: 'max' | 'min'): Set<number> => {
    const idx = series.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0);
    if (idx.length === 0) return new Set();
    const pick = idx.reduce((a, b) =>
      best === 'max' ? (series[b]! >= series[a]! ? b : a) : series[b]! <= series[a]! ? b : a,
    );
    return new Set([idx[idx.length - 1]!, pick]);
  };
  const valueLabels = labelled(values, 'max');
  const rankLabels = labelled(positions, 'min');

  const tickEvery = Math.max(1, Math.ceil(64 / Math.max(slot, 1)));
  const hovered = hover === null ? null : (points[hover] ?? null);
  const sentence = (p: HistoryPoint) => pointSentence(p, { showValues, rankPending, unit: unitLabel });

  const stackH = (showValues ? KPI_H + MID_H : 0) + RANK_H;
  const rankTop = showValues ? KPI_H + MID_H : 0;

  const onKey = (e: React.KeyboardEvent) => {
    if (n === 0) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const step = e.key === 'ArrowRight' ? 1 : -1;
      setHover((h) => Math.min(n - 1, Math.max(0, (h ?? n - 1) + (h === null ? 0 : step))));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setHover(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setHover(n - 1);
    } else if (e.key === 'Escape' && hover !== null) {
      // Clear the readout first; a second Escape closes the dialog.
      e.stopPropagation();
      setHover(null);
    }
  };

  return (
    <div className="rounded-lg border border-zinc-200/80 bg-white p-3 shadow-sm dark:border-blue-950/60 dark:bg-[#0d1117]">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="text-[12px] font-semibold text-zinc-900 dark:text-zinc-100">
          {showValues ? 'KPI performance' : 'Ranking performance'}
          <span className="ml-1.5 font-normal text-zinc-500 dark:text-zinc-400">
            {showValues ? `${unitLabel} each week` : 'position each week · #1 at the top'}
          </span>
        </h4>
        {showValues && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-600 dark:text-zinc-300">
            <LegendKey className="text-blue-600 dark:text-blue-500" label={personLabel} />
            <LegendKey className="text-zinc-500" label="Team average" />
          </div>
        )}
      </div>

      <div className="flex gap-1.5">
        {/* The axis gutter sits OUTSIDE the scroller, so its ticks stay on screen
            while a long history is scrolled. Same band heights as the plot. */}
        <div className="flex w-8 shrink-0 flex-col items-end" aria-hidden>
          {showValues && (
            <>
              <AxisTicks height={KPI_H} ticks={[[kpiMax, kpiY(kpiMax)], [kpiMax / 2, kpiY(kpiMax / 2)], [0, kpiY(0)]]} format={tick} />
              <div style={{ height: MID_H }} />
            </>
          )}
          <AxisTicks
            height={RANK_H}
            ticks={
              rankPending
                ? []
                : rankMax > 1
                  ? [
                      [1, rankY(1)],
                      [rankMax, rankY(rankMax)],
                    ]
                  : [[1, rankY(1)]]
            }
            format={(v) => `#${v}`}
          />
          <div style={{ height: AXIS_H }} />
        </div>

        <div ref={scrollerRef} className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain">
          <div ref={wrapRef} style={{ minWidth: n * MIN_SLOT_PX }}>
            <div
              className="relative rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
              style={{ width: plotW }}
              role="group"
              aria-label="KPI and ranking performance by week. Use the left and right arrow keys to read each week."
              aria-describedby={liveId}
              tabIndex={n > 0 ? 0 : -1}
              onKeyDown={onKey}
              onFocus={() => setHover((h) => h ?? n - 1)}
              onBlur={() => setHover(null)}
              onMouseLeave={() => setHover(null)}
            >
              {showValues && (
                <svg width={plotW} height={KPI_H} className="block overflow-visible" aria-hidden>
                  <Grid width={plotW} ys={[kpiY(kpiMax), kpiY(kpiMax / 2), kpiY(0)]} />
                  <g className="text-zinc-500">
                    {averageRuns.map((run, ri) => (
                      <Line key={ri} pts={run} revealed={revealed} reduce={reduce} delay={80} />
                    ))}
                  </g>
                  <g className="text-blue-600 dark:text-blue-500">
                    {personRuns.map((run, ri) => (
                      <g key={ri}>
                        <Line pts={run} revealed={revealed} reduce={reduce} />
                        <Markers pts={run} hover={hover} revealed={revealed} reduce={reduce} />
                      </g>
                    ))}
                  </g>
                  <PointLabels
                    runs={personRuns}
                    pick={valueLabels}
                    text={(i) => fmtCount(values[i]!)}
                    revealed={revealed}
                    reduce={reduce}
                  />
                </svg>
              )}

              {showValues && (
                <div className="flex items-end" style={{ height: MID_H }}>
                  {/* Sticky, so the strip's name stays in view while a long history scrolls. */}
                  <p className="sticky left-0 pb-1.5 text-[12px] font-semibold text-zinc-900 dark:text-zinc-100">
                    Ranking performance
                    <span className="ml-1.5 hidden font-normal text-zinc-500 sm:inline dark:text-zinc-400">
                      position each week · #1 at the top
                    </span>
                  </p>
                </div>
              )}

              <div className="relative" style={{ height: RANK_H }}>
                <svg width={plotW} height={RANK_H} className="block overflow-visible" aria-hidden>
                  <Grid width={plotW} ys={rankPending ? [] : rankMax > 1 ? [rankY(1), rankY(rankMax)] : [rankY(1)]} />
                  <g className="text-blue-600 dark:text-blue-500">
                    {rankRuns.map((run, ri) => (
                      <g key={ri}>
                        <Line pts={run} revealed={revealed} reduce={reduce} delay={120} />
                        <Markers pts={run} hover={hover} revealed={revealed} reduce={reduce} />
                      </g>
                    ))}
                  </g>
                  <PointLabels
                    runs={rankRuns}
                    pick={rankLabels}
                    text={(i) => `#${positions[i]!}`}
                    revealed={revealed}
                    reduce={reduce}
                  />
                </svg>
                {rankPending && (
                  <div className="absolute inset-0 flex items-center justify-center gap-2 text-[11.5px] text-zinc-500 dark:text-zinc-400">
                    <span className="skeleton-shimmer h-2.5 w-2.5 rounded-full" aria-hidden />
                    Loading each week&rsquo;s bonus order…
                  </div>
                )}
              </div>

              {/* Date ticks, anchored on the newest week so it is always labelled. */}
              <div className="relative" style={{ height: AXIS_H }} aria-hidden>
                {points.map((p, i) =>
                  (n - 1 - i) % tickEvery === 0 ? (
                    <span
                      key={p.periodStart}
                      className={cn(
                        'absolute top-1 whitespace-nowrap text-[10px] tabular-nums text-zinc-500 dark:text-zinc-400',
                        // A narrow slot cannot centre a date under the first or last
                        // week without clipping it at the edge, so those two anchor inward.
                        slot < 56 && i === n - 1 ? 'right-0' : slot < 56 && i === 0 ? 'left-0' : '-translate-x-1/2',
                      )}
                      style={slot < 56 && (i === n - 1 || i === 0) ? undefined : { left: xAt(i) }}
                    >
                      {dateLabel(p.periodStart, false)}
                    </span>
                  ) : null,
                )}
              </div>

              {/* Crosshair: finds the week, so the reader aims at a date, never at a 2px line. */}
              {hovered && (
                <div
                  className="pointer-events-none absolute top-0 w-px bg-zinc-300 dark:bg-zinc-700"
                  style={{ left: xAt(hover!), height: stackH }}
                  aria-hidden
                />
              )}

              {/* Hit targets: one full-height column per week, never an 8px dot. */}
              <div className="absolute inset-x-0 top-0 flex" style={{ height: stackH }} aria-hidden>
                {points.map((p, i) => (
                  <div
                    key={p.periodStart}
                    className={cn('h-full min-w-0 flex-1', hover === i && 'bg-zinc-900/[0.035] dark:bg-white/[0.05]')}
                    onMouseEnter={() => setHover(i)}
                  />
                ))}
              </div>

              {hovered && (
                <Tooltip
                  point={hovered}
                  x={xAt(hover!)}
                  width={plotW}
                  showValues={showValues}
                  rankPending={rankPending}
                  personLabel={personLabel}
                  unitLabel={unitLabel}
                  partLabels={partLabels}
                  rankTop={rankTop}
                />
              )}
              <span id={liveId} className="sr-only" aria-live="polite">
                {hovered ? sentence(hovered) : ''}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function LegendKey({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width="16" height="8" aria-hidden className={cn('overflow-visible', className)}>
        <line x1="0" y1="4" x2="16" y2="4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      {label}
    </span>
  );
}

function AxisTicks({
  height,
  ticks,
  format,
}: {
  height: number;
  ticks: readonly (readonly [number, number])[];
  format: (v: number) => string;
}) {
  return (
    <div className="relative w-full" style={{ height }}>
      {ticks.map(([v, y]) => (
        <span
          key={`${v}:${y}`}
          className="absolute right-0 -translate-y-1/2 text-[10px] tabular-nums text-zinc-500 dark:text-zinc-400"
          style={{ top: y }}
        >
          {format(v)}
        </span>
      ))}
    </div>
  );
}

function Grid({ width, ys }: { width: number; ys: readonly number[] }) {
  return (
    <>
      {ys.map((y) => (
        <line key={y} x1={0} x2={width} y1={y} y2={y} className="stroke-zinc-100 dark:stroke-zinc-800/80" strokeWidth={1} />
      ))}
    </>
  );
}

/**
 * A run's line, drawn on by animating `stroke-dashoffset` from its own length. That
 * composites and never reflows. `pathLength={1}` normalises the maths so one number
 * works for every run. Reduced motion skips straight to the finished line.
 */
function Line({ pts, revealed, reduce, delay = 0 }: { pts: Pt[]; revealed: boolean; reduce: boolean; delay?: number }) {
  if (pts.length < 2) return null;
  return (
    <path
      d={linePath(pts)}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      pathLength={1}
      style={{
        strokeDasharray: 1,
        strokeDashoffset: revealed ? 0 : 1,
        transition: reduce ? undefined : `stroke-dashoffset 900ms ${EASE_CSS} ${delay}ms`,
      }}
    />
  );
}

/**
 * Markers with a 2px SURFACE-coloured ring, so a dot stays legible where it crosses a
 * line: never a fixed white, which would punch a hole in the dark surface.
 */
function Markers({ pts, hover, revealed, reduce }: { pts: Pt[]; hover: number | null; revealed: boolean; reduce: boolean }) {
  return (
    <>
      {pts.map((p) => (
        <circle
          key={p.i}
          cx={p.x}
          cy={p.y}
          r={hover === p.i ? 5.5 : 4}
          fill="currentColor"
          className="stroke-white dark:stroke-[#0d1117]"
          strokeWidth={2}
          style={{
            opacity: revealed ? 1 : 0,
            transition: reduce ? undefined : 'opacity 300ms 500ms, r 150ms',
          }}
        />
      ))}
    </>
  );
}

function PointLabels({
  runs,
  pick,
  text,
  revealed,
  reduce,
}: {
  runs: Pt[][];
  pick: ReadonlySet<number>;
  text: (i: number) => string;
  revealed: boolean;
  reduce: boolean;
}) {
  return (
    <>
      {runs.flat().map((p) =>
        pick.has(p.i) ? (
          <text
            key={p.i}
            x={p.x}
            // Above the point, unless that would leave the strip (a #1, or a value at
            // the axis ceiling): the scroller clips anything outside its box.
            y={p.y - 9 < 10 ? p.y + 17 : p.y - 9}
            textAnchor="middle"
            className="fill-zinc-600 text-[10px] font-semibold tabular-nums dark:fill-zinc-300"
            style={{ opacity: revealed ? 1 : 0, transition: reduce ? undefined : 'opacity 300ms 650ms' }}
          >
            {text(p.i)}
          </text>
        ) : null,
      )}
    </>
  );
}

/**
 * One readout for every series at the week. Values lead, labels follow; each row is
 * keyed by a short stroke of its series colour. Flips side near the right edge.
 */
function Tooltip({
  point,
  x,
  width,
  showValues,
  rankPending,
  personLabel,
  unitLabel,
  partLabels,
  rankTop,
}: {
  point: HistoryPoint;
  x: number;
  width: number;
  showValues: boolean;
  rankPending: boolean;
  personLabel: string;
  unitLabel: string;
  partLabels?: Readonly<Record<string, string>>;
  rankTop: number;
}) {
  const flip = x > width - 190;
  const parts =
    point.parts && partLabels
      ? Object.keys(partLabels)
          .filter((k) => (point.parts![k] ?? 0) > 0)
          .map((k) => `${partLabels[k]} ${fmtCount(point.parts![k]!)}`)
      : [];
  return (
    <div
      className="pointer-events-none absolute z-20 w-max max-w-[15rem] rounded-lg border border-zinc-200 bg-white px-2.5 py-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
      style={{
        left: x,
        top: showValues ? 4 : rankTop + 4,
        transform: `translateX(${flip ? 'calc(-100% - 10px)' : '10px'})`,
      }}
    >
      <p className="text-[11px] font-semibold text-zinc-900 dark:text-zinc-100">{weekRangeLabel(point.periodStart)}</p>
      <div className="mt-1 space-y-0.5 text-[11px] text-zinc-600 dark:text-zinc-300">
        {showValues && (
          <>
            <TipRow keyClass="text-blue-600 dark:text-blue-500">
              {point.value === null ? (
                <span className="text-zinc-500 dark:text-zinc-400">No entry for {personLabel}</span>
              ) : (
                <>
                  <strong className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{fmtCount(point.value)}</strong>{' '}
                  {unitLabel} · {personLabel}
                </>
              )}
            </TipRow>
            {parts.length > 0 && <p className="pl-[22px] text-[10.5px] text-zinc-500 dark:text-zinc-400">{parts.join(' · ')}</p>}
            {point.teamAverage !== null && (
              <TipRow keyClass="text-zinc-500">
                <strong className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                  {point.teamAverage.toFixed(1)}
                </strong>{' '}
                team average
              </TipRow>
            )}
          </>
        )}
        <TipRow keyClass="text-blue-600 dark:text-blue-500" dot>
          {rankPending ? (
            <span className="text-zinc-500 dark:text-zinc-400">Rank loading…</span>
          ) : point.position !== null ? (
            <>
              <strong className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">#{point.position}</strong> of{' '}
              {point.ranked} that week
            </>
          ) : (
            <span className="text-zinc-500 dark:text-zinc-400">Not ranked — no entry</span>
          )}
        </TipRow>
      </div>
    </div>
  );
}

function TipRow({ keyClass, dot, children }: { keyClass: string; dot?: boolean; children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-1.5">
      <svg width="16" height="8" aria-hidden className={cn('shrink-0 overflow-visible', keyClass)}>
        {dot ? (
          <circle cx="8" cy="4" r="3" fill="currentColor" />
        ) : (
          <line x1="0" y1="4" x2="16" y2="4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        )}
      </svg>
      <span>{children}</span>
    </p>
  );
}
