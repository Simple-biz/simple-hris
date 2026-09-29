'use client';

// Manager → KPI Calculator → Departments AND → HSL Branches: the three insight
// cards above each grid. Doc: docs/features/kpi-calculator-insights.md.
// Data: GET /api/manager/kpi-insights (Departments) · …/kpi-insights/hsl (HSL).
//
//   [ Department spotlight ][ Top earner ][ Sent to Accounting ── trend ───── ]
//
// Read-only. Every figure is PESOS — the stored PHP the Payroll Wizard pays
// (`bonus_catalog_applied.amount`, `hsl_bonus_entries.calculated_bonus`) — for
// the same reason the grid's cards are (Kane, 2026-09-08: native settlement
// figures belong inside the calculator, not the chrome). The two calculators get
// the same cards; only the endpoint, the cache surface, the colours and the word
// for a row differ ("a shared shape is worth copying; a wrong label is not",
// hsl-kpi-calculator-2026-07.md § One header).
//
// A cached payload PAINTS and never decides (kpi-cache.ts): the cards always
// refetch, and a refetch holds the previous render at reduced opacity rather than
// flashing a skeleton.

import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AnimatePresence,
  animate,
  motion,
  useAnimationFrame,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from 'motion/react';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  RefreshCw,
  Shuffle,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Trophy,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { catalogDeptColor } from '@/lib/departments/dept-identity';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import {
  compactPeso,
  monotonePath,
  niceTicks,
  toRuns,
  type DeptAverage,
  type KpiInsightsResponse,
  type TopEarner,
  type TrendWeek,
} from '@/lib/manager/kpi-insights';
import { KPI_CACHE_KEYS, getKpiCache, setKpiCache, type KpiCacheSurface } from '@/lib/manager/kpi-cache';

/** Which calculator the cards sit on. */
export type KpiInsightCalculator = 'dept' | 'hsl';

const CALCULATORS: Record<
  KpiInsightCalculator,
  {
    endpoint: string;
    surface: KpiCacheSurface;
    /** What one row of that calculator is called. */
    noun: { one: string; many: string; One: string; Many: string };
  }
> = {
  dept: {
    endpoint: '/api/manager/kpi-insights',
    surface: 'dept-manager',
    noun: { one: 'department', many: 'departments', One: 'Department', Many: 'Departments' },
  },
  hsl: {
    endpoint: '/api/manager/kpi-insights/hsl',
    surface: 'hsl',
    noun: { one: 'branch', many: 'branches', One: 'Branch', Many: 'Branches' },
  },
};

/** The noun and colour resolver every card reads, set once by the container. */
const CardsContext = React.createContext<{
  noun: (typeof CALCULATORS)[KpiInsightCalculator]['noun'];
  colorFor: (key: string) => string;
}>({ noun: CALCULATORS.dept.noun, colorFor: catalogDeptColor });

const EASE = [0.22, 1, 0.36, 1] as const;
/** The spotlight's dwell per department. */
const ROTATE_MS = 5200;
/** A live-figure change (a save, a Mark Ready) refetches after this quiet spell —
 *  the calculator autosaves on a 1 s debounce, and one read per burst is plenty. */
const LIVE_REFETCH_DEBOUNCE_MS = 4000;
/** The row's grid. One constant so the calculator skeleton's placeholder row
 *  ({@link KpiInsightCardsSkeleton}) cannot drift from the row that replaces it. */
const INSIGHT_GRID = 'grid grid-cols-1 gap-3 px-4 pt-5 sm:px-6 md:grid-cols-2 xl:grid-cols-4';

// -- Formatting ------------------------------------------------------------------

function peso(n: number): string {
  return `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function weekRange(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const end = new Date(Date.UTC(y!, m! - 1, d! + 6)).toISOString().slice(0, 10);
  return `${shortDate(iso)} – ${shortDate(end)}`;
}

function initials(name: string): string {
  // "Santos, Jane Marie" → "JS"; "Jane Santos" → "JS".
  const cleaned = name.replace(/["“”].*?["“”]/g, ' ').trim();
  const [last, first] = cleaned.includes(',') ? cleaned.split(',', 2).map((s) => s.trim()) : [null, null];
  const parts = (first && last ? `${first} ${last}` : cleaned).split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const a = parts[0]!.charAt(0);
  const b = parts.length > 1 ? parts[parts.length - 1]!.charAt(0) : '';
  return (a + b).toUpperCase();
}

/** A peso figure that eases from its last value to the new one (from ₱0 on
 *  mount). Proportional figures: this is a standalone number, not a column. */
function AnimatedPeso({ value, className }: { value: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  const shown = useRef(reduce ? value : 0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduce) {
      shown.current = value;
      el.textContent = peso(value);
      return;
    }
    const controls = animate(shown.current, value, {
      duration: 0.9,
      ease: EASE,
      onUpdate: (v) => {
        shown.current = v;
        el.textContent = peso(v);
      },
    });
    return () => controls.stop();
  }, [value, reduce]);
  return (
    <span ref={ref} className={className}>
      {peso(reduce ? value : shown.current)}
    </span>
  );
}

/** Salt for the top earner's first draw: once per page load, never per render. */
const SESSION_SALT = Math.floor(Math.random() * 0x7fffffff);

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// -- Shell -----------------------------------------------------------------------

function CardShell({
  eyebrow,
  icon,
  right,
  className,
  children,
  dim,
}: {
  eyebrow: string;
  icon: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
  /** A refetch is in flight over a painted figure. */
  dim?: boolean;
}) {
  return (
    <motion.section
      variants={{
        hidden: { opacity: 0, y: 8 },
        show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE } },
      }}
      className={cn(
        'relative flex min-h-[208px] min-w-0 flex-col rounded-xl border border-zinc-200 bg-white p-4',
        'dark:border-zinc-800 dark:bg-zinc-950/50',
        className,
      )}
    >
      <header className="mb-3 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
          <span aria-hidden className="text-zinc-400 dark:text-zinc-500">
            {icon}
          </span>
          {eyebrow}
        </p>
        {right}
      </header>
      <div className={cn('flex min-h-0 flex-1 flex-col transition-opacity duration-300', dim && 'opacity-60')}>
        {children}
      </div>
    </motion.section>
  );
}

function CardError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-start justify-center gap-2 text-xs text-zinc-500">
      <span>Couldn&apos;t load this card.</span>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
      >
        <RefreshCw className="h-3 w-3" aria-hidden /> Retry
      </button>
    </div>
  );
}

// Each card's first-load body. Shared with `KpiInsightCardsSkeleton`, so the
// calculator skeleton and a card waiting on its first fetch are the same shape.

function SpotlightLoading() {
  return (
    <div className="flex flex-1 flex-col gap-3">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-3 w-48" />
      <Skeleton className="mt-auto h-10 w-full" />
    </div>
  );
}

function TopEarnerLoading() {
  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="flex items-center gap-3">
        <Skeleton className="h-11 w-11 rounded-full" />
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
      <Skeleton className="h-7 w-36" />
    </div>
  );
}

function TrendLoading() {
  return (
    <div className="flex flex-1 flex-col gap-3">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-[120px] w-full" />
    </div>
  );
}

// -- 1 · Department spotlight -------------------------------------------------------

function DeptSpotlightCard({
  depts,
  weeks,
  labelFor,
  loading,
  failed,
  dim,
  onRetry,
}: {
  depts: DeptAverage[];
  weeks: TrendWeek[];
  labelFor: (key: string) => string;
  loading: boolean;
  failed: boolean;
  dim: boolean;
  onRetry: () => void;
}) {
  const reduce = !!useReducedMotion();
  const { noun, colorFor } = React.useContext(CardsContext);
  // Highest average first, so the rotation reads as a ranking; a department that
  // sent nothing in the window still gets its turn, last.
  const ranked = useMemo(
    () =>
      [...depts].sort(
        (a, b) =>
          Number(b.weeksSent > 0) - Number(a.weeksSent > 0) ||
          b.avgWeekly - a.avgWeekly ||
          labelFor(a.dept).localeCompare(labelFor(b.dept)),
      ),
    [depts, labelFor],
  );
  const [idx, setIdx] = useState(0);
  const [dir, setDir] = useState(1);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = reduce || hovered || focused || ranked.length < 2;
  const elapsed = useRef(0);
  const progress = useMotionValue(0);

  // Keep the index in range when the department set changes under us.
  useEffect(() => {
    if (idx >= ranked.length) setIdx(0);
  }, [idx, ranked.length]);

  const go = useCallback(
    (next: number, direction: number) => {
      if (ranked.length === 0) return;
      setDir(direction);
      setIdx(((next % ranked.length) + ranked.length) % ranked.length);
      elapsed.current = 0;
      progress.set(0);
    },
    [ranked.length, progress],
  );

  // One clock drives both the dwell and the progress pill, so pausing freezes the
  // pill exactly where it is and resuming carries on from there.
  useAnimationFrame((_, delta) => {
    if (paused || (typeof document !== 'undefined' && document.hidden)) return;
    elapsed.current += delta;
    progress.set(Math.min(1, elapsed.current / ROTATE_MS));
    if (elapsed.current >= ROTATE_MS) go(idx + 1, 1);
  });

  const cur = ranked[idx];
  const color = cur ? colorFor(cur.dept) : '#71717a';
  const max = cur ? Math.max(0, ...cur.series.map((v) => v ?? 0)) : 0;

  return (
    <CardShell
      eyebrow={`${noun.One} spotlight`}
      icon={<Sparkles className="h-3 w-3" />}
      dim={dim}
      right={
        ranked.length > 1 ? (
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              aria-label={`Previous ${noun.one}`}
              onClick={() => go(idx - 1, -1)}
              className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-900 dark:hover:text-zinc-200"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              aria-label={`Next ${noun.one}`}
              onClick={() => go(idx + 1, 1)}
              className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-900 dark:hover:text-zinc-200"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : undefined
      }
    >
      {failed && ranked.length === 0 ? (
        <CardError onRetry={onRetry} />
      ) : loading && ranked.length === 0 ? (
        <SpotlightLoading />
      ) : !cur ? (
        <p className="flex flex-1 items-center text-xs text-zinc-500">No {noun.many} to show.</p>
      ) : (
        <div
          className="flex min-h-0 flex-1 flex-col"
          role="group"
          aria-roledescription="carousel"
          aria-label={`Average bonus per week, one ${noun.one} at a time`}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onFocus={() => setFocused(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
          }}
        >
          <div className="relative min-h-0 flex-1 overflow-hidden" aria-live={paused ? 'polite' : 'off'}>
            <AnimatePresence mode="popLayout" initial={false} custom={dir}>
              <motion.div
                key={cur.dept}
                custom={dir}
                variants={{
                  enter: (d: number) => (reduce ? { opacity: 0 } : { opacity: 0, x: 18 * d, filter: 'blur(2px)' }),
                  center: { opacity: 1, x: 0, filter: 'blur(0px)' },
                  exit: (d: number) => (reduce ? { opacity: 0 } : { opacity: 0, x: -18 * d, filter: 'blur(2px)' }),
                }}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.42, ease: EASE }}
                className="flex h-full flex-col"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span aria-hidden className="h-4 w-1 flex-none rounded-full" style={{ backgroundColor: color }} />
                  <span className="truncate text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
                    {formatDeptLabel(labelFor(cur.dept))}
                  </span>
                  <span className="ml-auto flex-none rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-[0.08em] text-zinc-600 dark:bg-zinc-800/70 dark:text-zinc-300">
                    #{idx + 1} of {ranked.length}
                  </span>
                </div>

                <div className="mt-2 flex items-baseline gap-1.5">
                  {cur.weeksSent > 0 ? (
                    <>
                      <AnimatedPeso
                        value={cur.avgWeekly}
                        className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50"
                      />
                      <span className="text-xs text-zinc-500">/ week</span>
                    </>
                  ) : (
                    <span className="text-sm text-zinc-500">Nothing sent in the last {weeks.length} weeks</span>
                  )}
                </div>
                {cur.weeksSent > 0 && (
                  <p className="mt-0.5 text-[11px] text-zinc-500">
                    {peso(cur.avgPerPerson)} per person · {cur.weeksSent} of {weeks.length} weeks sent
                  </p>
                )}

                {/* The department's own weeks, oldest first. A week it did not
                    send gets NO bar — a flat stub on the baseline, never a
                    zero-height column that reads as ₱0. */}
                <div className="mt-auto flex h-10 items-end gap-[3px] pt-3" aria-hidden>
                  {cur.series.map((v, i) => {
                    const h = v !== null && max > 0 ? Math.max(3, (v / max) * 100) : 0;
                    return (
                      <div
                        key={weeks[i]?.weekStart ?? i}
                        className="flex h-full min-w-0 flex-1 items-end"
                        title={
                          weeks[i]
                            ? `${weekRange(weeks[i]!.weekStart)} · ${v === null ? 'not sent' : peso(v)}`
                            : undefined
                        }
                      >
                        {v === null ? (
                          <div className="h-px w-full bg-zinc-200 dark:bg-zinc-800" />
                        ) : (
                          <motion.div
                            className="w-full max-w-[24px] rounded-t-[4px]"
                            style={{ backgroundColor: color }}
                            initial={reduce ? false : { height: '0%' }}
                            animate={{ height: `${h}%` }}
                            transition={{ duration: reduce ? 0 : 0.55, ease: EASE, delay: reduce ? 0 : 0.08 + i * 0.025 }}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            </AnimatePresence>
          </div>

          {ranked.length > 1 && (
            <div className="mt-3 flex items-center gap-1" role="tablist" aria-label={noun.Many}>
              {ranked.map((d, i) => {
                const active = i === idx;
                return (
                  <button
                    key={d.dept}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-label={formatDeptLabel(labelFor(d.dept))}
                    title={formatDeptLabel(labelFor(d.dept))}
                    onClick={() => go(i, i >= idx ? 1 : -1)}
                    className="group flex h-4 items-center"
                  >
                    <motion.span
                      layout
                      transition={{ duration: 0.35, ease: EASE }}
                      className={cn(
                        'relative block h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800',
                        active ? 'w-6' : 'w-1.5 group-hover:bg-zinc-300 dark:group-hover:bg-zinc-700',
                      )}
                    >
                      {active && (
                        <motion.span
                          className="absolute inset-0 origin-left rounded-full"
                          style={{
                            backgroundColor: colorFor(d.dept),
                            // Paused (hover, focus, hidden tab) freezes it where it is.
                            scaleX: reduce ? 1 : progress,
                          }}
                        />
                      )}
                    </motion.span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </CardShell>
  );
}

// -- 2 · Top earner ----------------------------------------------------------------

function TopEarnerCard({
  top,
  tiedCount,
  peoplePaid,
  weekTotal,
  runnerUpAmount,
  week,
  labelFor,
  loading,
  failed,
  dim,
  onRetry,
}: {
  top: TopEarner[];
  tiedCount: number;
  peoplePaid: number;
  weekTotal: number;
  runnerUpAmount: number;
  week: string;
  labelFor: (key: string) => string;
  loading: boolean;
  failed: boolean;
  dim: boolean;
  onRetry: () => void;
}) {
  const reduce = !!useReducedMotion();
  const { noun, colorFor } = React.useContext(CardsContext);
  // A tie is common — a flat common bonus ties a whole department — so the card
  // draws one of the tied people at random, and Shuffle draws another. The draw
  // is re-rolled only when the pool itself changes, never on a re-render.
  const poolKey = `${week}|${top.map((t) => t.key).join(',')}|${top[0]?.amount ?? 0}`;
  // The first draw is a hash of the pool salted once per page load: random to the
  // reader, but stable across re-renders, so the card never swaps person right
  // after it paints. Shuffle draws for real, in the click handler.
  const drawn = top.length > 1 ? ((hashString(poolKey) ^ SESSION_SALT) >>> 0) % top.length : 0;
  const [override, setOverride] = useState<{ pool: string; pick: number } | null>(null);
  const pick = override && override.pool === poolKey ? override.pick : drawn;
  const shuffle = () => {
    if (top.length < 2) return;
    let next = pick;
    while (next === pick) next = Math.floor(Math.random() * top.length);
    setOverride({ pool: poolKey, pick: next });
  };
  const person = top[Math.min(pick, Math.max(0, top.length - 1))];
  const color = person ? colorFor(person.depts[0] ?? '') : '#71717a';

  return (
    <CardShell
      eyebrow="Top earner"
      icon={<Trophy className="h-3 w-3" />}
      dim={dim}
      right={<span className="font-mono text-[10px] text-zinc-500">week of {shortDate(week)}</span>}
    >
      {failed && !person ? (
        <CardError onRetry={onRetry} />
      ) : loading && !person ? (
        <TopEarnerLoading />
      ) : !person ? (
        <p className="flex flex-1 items-center text-xs text-zinc-500">No bonuses saved for this week yet.</p>
      ) : (
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={`${poolKey}#${person.key}`}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -10, scale: 0.98 }}
              transition={{ duration: 0.4, ease: EASE }}
              className="flex h-full flex-col"
            >
              <div className="flex min-w-0 items-center gap-3">
                <motion.span
                  aria-hidden
                  className="relative grid h-11 w-11 flex-none place-items-center rounded-full border-2 text-sm font-semibold text-zinc-900 dark:text-zinc-50"
                  // The ring is a BORDER, inside the 44px box. A `0 0 0 2px`
                  // box-shadow ring paints outside it, and the card's
                  // overflow-hidden wrapper sliced its left and top edges flat.
                  style={{
                    backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)`,
                    borderColor: color,
                  }}
                  initial={reduce ? false : { scale: 0.6, rotate: -8 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: 'spring', stiffness: 380, damping: 22 }}
                >
                  {initials(person.name)}
                </motion.span>
                <div className="min-w-0">
                  <p
                    className="truncate text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100"
                    title={person.email ?? undefined}
                  >
                    {person.name}
                  </p>
                  <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-500">
                    {person.depts.map((d) => (
                      <span key={d} className="inline-flex items-center gap-1">
                        <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: colorFor(d) }} />
                        {formatDeptLabel(labelFor(d))}
                      </span>
                    ))}
                  </p>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <AnimatedPeso
                  value={person.amount}
                  className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50"
                />
                {person.sent ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800/60">
                    <CheckCircle2 className="h-3 w-3" aria-hidden /> Sent
                  </span>
                ) : (
                  <span
                    className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-700 ring-1 ring-zinc-200 dark:bg-zinc-800/60 dark:text-zinc-300 dark:ring-zinc-700"
                    title={`At least one of their ${noun.many} hasn't been sent to Accounting for this week`}
                  >
                    <Clock className="h-3 w-3" aria-hidden /> Projected
                  </span>
                )}
              </div>

              {/* What the figure is against: the week's average bonus, and the gap
                  to the next person down (or the size of the tie). */}
              <dl className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-zinc-50 px-2.5 py-1.5 dark:bg-zinc-900/60">
                  <dt className="text-[10px] text-zinc-500">Week average</dt>
                  <dd className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                    {peoplePaid > 0 ? peso(weekTotal / peoplePaid) : '—'}
                    {peoplePaid > 0 && weekTotal > 0 && (
                      <span className="ml-1 font-normal text-zinc-500">
                        · {(person.amount / (weekTotal / peoplePaid)).toFixed(1)}×
                      </span>
                    )}
                  </dd>
                </div>
                <div className="rounded-lg bg-zinc-50 px-2.5 py-1.5 dark:bg-zinc-900/60">
                  <dt className="text-[10px] text-zinc-500">{tiedCount > 1 ? 'Tied at the top' : 'Ahead of #2'}</dt>
                  <dd className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                    {tiedCount > 1
                      ? `${tiedCount.toLocaleString('en-US')} people`
                      : runnerUpAmount > 0
                        ? `+${peso(person.amount - runnerUpAmount)}`
                        : '—'}
                  </dd>
                </div>
              </dl>

              <div className="mt-auto flex items-center justify-between gap-2 pt-3 text-[11px] text-zinc-500">
                <span>
                  Highest of {peoplePaid.toLocaleString('en-US')} {peoplePaid === 1 ? 'person' : 'people'}
                  {tiedCount > 1 && ` · tied with ${(tiedCount - 1).toLocaleString('en-US')}`}
                </span>
                {top.length > 1 && (
                  <button
                    type="button"
                    onClick={shuffle}
                    className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
                    title="Show another person tied for the top"
                  >
                    <Shuffle className="h-3 w-3" aria-hidden /> Shuffle
                  </button>
                )}
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      )}
    </CardShell>
  );
}

// -- 3 · Sent to Accounting trend ------------------------------------------------------

function useMeasuredWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setW(Math.round(entries[0]?.contentRect.width ?? 0)));
    ro.observe(el);
    setW(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Wipe easing, and its inverse — so each marker pops exactly when the wipe's
 *  leading edge reaches it, not on a guessed stagger. */
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutCubicInverse = (f: number) => 1 - Math.cbrt(1 - Math.min(1, Math.max(0, f)));
const WIPE_S = 1.25;
const MORPH = { duration: 0.6, ease: EASE };

function KpiSentTrendChart({
  weeks,
  deptCount,
  selectedWeek,
  height = 150,
}: {
  weeks: TrendWeek[];
  deptCount: number;
  selectedWeek: string;
  height?: number;
}) {
  const reduce = !!useReducedMotion();
  const { noun } = React.useContext(CardsContext);
  const [wrapRef, width] = useMeasuredWidth();
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [active, setActive] = useState<number | null>(null);

  const padL = 46;
  const padR = 14;
  const padT = 18;
  const padB = 22;
  const plotW = Math.max(0, width - padL - padR);
  const plotH = Math.max(0, height - padT - padB);
  const n = weeks.length;

  const axis = niceTicks(Math.max(0, ...weeks.filter((w) => w.measured).map((w) => w.sent)));
  const max = axis.top;
  const xAt = (i: number) => (n <= 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const yAt = (v: number) => padT + plotH - (v / max) * plotH;
  const baseY = padT + plotH;

  const runs = toRuns(weeks.map((w, i) => (w.measured ? { i, w } : null)));
  const linePath = runs.map((r) => monotonePath(r.items.map(({ i, w }) => ({ x: xAt(i), y: yAt(w.sent) })))).join('');
  const areaPath = runs
    .filter((r) => r.items.length > 1)
    .map((r) => {
      const d = monotonePath(r.items.map(({ i, w }) => ({ x: xAt(i), y: yAt(w.sent) })));
      const first = r.items[0]!.i;
      const last = r.items[r.items.length - 1]!.i;
      return `${d}L${xAt(last)},${baseY}L${xAt(first)},${baseY}Z`;
    })
    .join('');

  // The wipe replays only when the path's STRUCTURE changes (a new week, a new
  // gap) — a refetch that only moves values morphs `d` in place instead, which
  // is what keeps a Mark Ready elsewhere from restarting the whole animation.
  const structure = `${n}|${runs.map((r) => `${r.start}:${r.items.length}`).join(',')}|${width > 0}`;
  const [revealKey, setRevealKey] = useState(structure);
  useEffect(() => setRevealKey(structure), [structure]);

  const ticks = axis.ticks;
  const measuredIdx = weeks.map((w, i) => (w.measured ? i : -1)).filter((i) => i >= 0);
  const lastIdx = measuredIdx[measuredIdx.length - 1] ?? -1;
  const peakIdx = measuredIdx.reduce((best, i) => (best < 0 || weeks[i]!.sent > weeks[best]!.sent ? i : best), -1);
  const labelIdx = new Set<number>([lastIdx]);
  if (peakIdx >= 0 && peakIdx !== lastIdx && Math.abs(xAt(peakIdx) - xAt(lastIdx)) > 64) labelIdx.add(peakIdx);

  // X labels: the selected week, the newest and the oldest first; then every
  // other week that clears the labels already placed by a label's width.
  const selIdx = weeks.findIndex((w) => w.weekStart === selectedWeek);
  const xLabels = new Set<number>();
  for (const i of [selIdx, n - 1, 0, ...weeks.map((_, k) => k)]) {
    if (i < 0 || i >= n || xLabels.has(i)) continue;
    if ([...xLabels].every((j) => Math.abs(xAt(j) - xAt(i)) >= 40)) xLabels.add(i);
  }

  // The crosshair and tooltip glide between weeks on a spring.
  const crossX = useSpring(0, { stiffness: 420, damping: 38 });
  const crossY = useSpring(0, { stiffness: 420, damping: 38 });
  const half = 110; // half the tooltip's 212px width + a margin, so it never leaves the card
  const tipLeft = useTransform(crossX, (v) => Math.max(half, Math.min(Math.max(half, width - half), v)));
  const tipTop = useTransform(crossY, (v) => v - 12);
  useEffect(() => {
    if (active === null) return;
    const w = weeks[active];
    if (!w) return;
    if (reduce) {
      crossX.jump(xAt(active));
      crossY.jump(yAt(w.sent));
    } else {
      crossX.set(xAt(active));
      crossY.set(yAt(w.sent));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, width, max, weeks, reduce]);

  const nearestMeasured = (i: number) =>
    measuredIdx.reduce((best, m) => (best < 0 || Math.abs(m - i) < Math.abs(best - i) ? m : best), -1);

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    if (measuredIdx.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = plotW > 0 ? (e.clientX - rect.left) / plotW : 0;
    const i = nearestMeasured(Math.round(ratio * (n - 1)));
    if (i < 0) return;
    if (active === null) {
      crossX.jump(xAt(i));
      crossY.jump(yAt(weeks[i]!.sent));
    }
    setActive(i);
  };

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (measuredIdx.length === 0) return;
    const pos = active === null ? measuredIdx.length : measuredIdx.indexOf(active);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next =
        e.key === 'ArrowRight'
          ? measuredIdx[Math.min(measuredIdx.length - 1, active === null ? measuredIdx.length - 1 : pos + 1)]
          : measuredIdx[Math.max(0, active === null ? measuredIdx.length - 1 : pos - 1)];
      if (next !== undefined) {
        if (active === null) {
          crossX.jump(xAt(next));
          crossY.jump(yAt(weeks[next]!.sent));
        }
        setActive(next);
      }
    } else if (e.key === 'Escape') {
      setActive(null);
    }
  };

  const tip = active !== null ? weeks[active] : undefined;
  const prev = tip && active !== null ? weeks.slice(0, active).reverse().find((w) => w.measured) : undefined;
  const delta = tip && prev && prev.sent > 0 ? (tip.sent - prev.sent) / prev.sent : null;

  return (
    <div
      ref={wrapRef}
      className="relative w-full select-none outline-none [--kpi-series:#059669] [--kpi-surface:#ffffff] focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-blue-500 dark:[--kpi-series:#12a574] dark:[--kpi-surface:#09090b]"
      style={{ height }}
      tabIndex={measuredIdx.length > 0 ? 0 : -1}
      role="group"
      aria-label="Total KPI bonuses sent to Accounting per week. Use the left and right arrow keys to read each week."
      onKeyDown={onKey}
      onFocus={() => {
        if (active === null && lastIdx >= 0) {
          crossX.jump(xAt(lastIdx));
          crossY.jump(yAt(weeks[lastIdx]!.sent));
          setActive(lastIdx);
        }
      }}
      onBlur={() => setActive(null)}
    >
      {width > 0 && (
        <svg width={width} height={height} className="overflow-visible" aria-hidden>
          <defs>
            <linearGradient id={`area-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: 'var(--kpi-series)', stopOpacity: 0.16 }} />
              <stop offset="100%" style={{ stopColor: 'var(--kpi-series)', stopOpacity: 0 }} />
            </linearGradient>
            <clipPath id={`wipe-${uid}`}>
              <motion.rect
                key={revealKey}
                x={padL - 8}
                y={0}
                height={height}
                initial={{ width: reduce ? plotW + padR + 16 : 0 }}
                animate={{ width: plotW + padR + 16 }}
                transition={{ duration: reduce ? 0 : WIPE_S, ease: easeOutCubic }}
              />
            </clipPath>
          </defs>

          {/* The selected week (the picker's), as a quiet column behind the data. */}
          {selIdx >= 0 && (
            <motion.rect
              initial={false}
              animate={{ x: Math.min(width - padR, Math.max(padL, xAt(selIdx) - 9)) }}
              transition={MORPH}
              y={padT}
              width={selIdx === n - 1 || selIdx === 0 ? 9 : 18}
              height={plotH}
              className="fill-zinc-100/80 dark:fill-white/[0.035]"
            />
          )}

          {/* A week with nothing saved has NO mark — a 45° hatch between its
              neighbours instead, so the break reads as "no record", never as a
              drop to ₱0 and never as a glitch. */}
          <defs>
            <pattern id={`hatch-${uid}`} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1={0} y1={0} x2={0} y2={6} className="stroke-zinc-200 dark:stroke-zinc-800" strokeWidth={2} />
            </pattern>
          </defs>
          {weeks.map((w, i) =>
            w.measured ? null : (
              <rect
                key={`gap:${w.weekStart}`}
                x={Math.max(padL, xAt(i) - plotW / Math.max(1, n - 1) / 2)}
                y={padT}
                width={Math.min(plotW / Math.max(1, n - 1), width - padR - Math.max(padL, xAt(i) - plotW / Math.max(1, n - 1) / 2))}
                height={plotH}
                fill={`url(#hatch-${uid})`}
                opacity={0.9}
              >
                <title>{`${weekRange(w.weekStart)} · nothing saved`}</title>
              </rect>
            ),
          )}

          {/* Gridlines: solid hairlines, zero-based (an area encodes value from 0). */}
          {ticks.map((t, i) => (
            <g key={i}>
              <motion.line
                initial={false}
                animate={{ y1: yAt(t), y2: yAt(t) }}
                transition={MORPH}
                x1={padL}
                x2={width - padR}
                className={i === 0 ? 'stroke-zinc-300 dark:stroke-zinc-700' : 'stroke-zinc-100 dark:stroke-zinc-800/80'}
                strokeWidth={1}
              />
              {(ticks.length <= 4 || i % 2 === 0 || plotH > 140) && (
                <motion.text
                  initial={false}
                  animate={{ y: yAt(t) + 3 }}
                  transition={MORPH}
                  x={padL - 8}
                  textAnchor="end"
                  className="fill-zinc-400 font-mono text-[9px] tabular-nums dark:fill-zinc-500"
                >
                  {compactPeso(t)}
                </motion.text>
              )}
            </g>
          ))}

          <g clipPath={`url(#wipe-${uid})`}>
            <motion.path
              initial={false}
              animate={{ d: areaPath || 'M0,0' }}
              transition={MORPH}
              fill={`url(#area-${uid})`}
            />
            <motion.path
              initial={false}
              animate={{ d: linePath || 'M0,0' }}
              transition={MORPH}
              fill="none"
              style={{ stroke: 'var(--kpi-series)' }}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>

          {/* Markers: r=4 with a 2px surface ring. The NEWEST week is hollow
              while a department has not sent — its figure can still rise. An
              older week one department never sent is a settled record, not an
              open one, and stays solid (the tooltip says who is missing). */}
          {weeks.map((w, i) => {
            if (!w.measured) return null;
            const partial = i === lastIdx && w.sentDepts < deptCount;
            const delay = reduce ? 0 : WIPE_S * easeOutCubicInverse(plotW > 0 ? (xAt(i) - padL) / plotW : 0);
            return (
              <motion.circle
                key={`${revealKey}:${w.weekStart}`}
                cx={xAt(i)}
                initial={reduce ? { cy: yAt(w.sent), r: 4 } : { cy: yAt(w.sent), r: 0 }}
                animate={{ cy: yAt(w.sent), r: 4 }}
                transition={{ cy: MORPH, r: { type: 'spring', stiffness: 520, damping: 18, delay } }}
                style={{
                  fill: partial ? 'var(--kpi-surface)' : 'var(--kpi-series)',
                  stroke: partial ? 'var(--kpi-series)' : 'var(--kpi-surface)',
                }}
                strokeWidth={2}
              />
            );
          })}

          {/* Selective direct labels: the newest week and the peak — never every point. */}
          {[...labelIdx].map((i) => {
            const w = weeks[i];
            if (!w) return null;
            const x = xAt(i);
            const anchor = x > width - padR - 40 ? 'end' : x < padL + 40 ? 'start' : 'middle';
            return (
              <g
                key={`label:${revealKey}:${i}`}
                style={{ opacity: active === null ? 1 : 0.2, transition: 'opacity 160ms ease-out' }}
              >
                <motion.text
                  x={x}
                  initial={reduce ? { y: yAt(w.sent) - 10, opacity: 1 } : { y: yAt(w.sent) - 4, opacity: 0 }}
                  animate={{ y: yAt(w.sent) - 10, opacity: 1 }}
                  transition={{ duration: 0.45, ease: EASE, delay: reduce ? 0 : WIPE_S * 0.8 }}
                  textAnchor={anchor}
                  className="fill-zinc-700 text-[10px] font-semibold dark:fill-zinc-200"
                >
                  {compactPeso(w.sent)}
                </motion.text>
              </g>
            );
          })}

          {weeks.map((w, i) =>
            xLabels.has(i) ? (
              <text
                key={`x:${w.weekStart}`}
                x={xAt(i)}
                y={height - 5}
                textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
                className={cn(
                  'font-mono text-[9px] tabular-nums',
                  i === selIdx ? 'fill-zinc-800 font-semibold dark:fill-zinc-100' : 'fill-zinc-400 dark:fill-zinc-500',
                )}
              >
                {shortDate(w.weekStart)}
              </text>
            ) : null,
          )}

          {/* Crosshair — springs between weeks rather than jumping. */}
          <AnimatePresence>
            {active !== null && (
              <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
                <motion.line
                  x1={crossX}
                  x2={crossX}
                  y1={padT - 4}
                  y2={baseY}
                  className="stroke-zinc-300 dark:stroke-zinc-600"
                  strokeWidth={1}
                />
                <motion.circle
                  cx={crossX}
                  cy={crossY}
                  r={5.5}
                  style={{ fill: 'var(--kpi-series)', stroke: 'var(--kpi-surface)' }}
                  strokeWidth={2}
                />
              </motion.g>
            )}
          </AnimatePresence>

          <rect
            x={padL - 12}
            y={0}
            width={Math.max(0, plotW + 24)}
            height={height}
            fill="transparent"
            style={{ cursor: measuredIdx.length > 0 ? 'crosshair' : 'default' }}
            onPointerMove={onMove}
            onPointerDown={onMove}
            onPointerLeave={() => setActive(null)}
          />
        </svg>
      )}

      <AnimatePresence>
        {tip && active !== null && (
          // Two layers on purpose: the outer one is PLACED (it rides the spring,
          // centred over the point and lifted clear of it), the inner one
          // ENTERS. On one element the entrance's `y` overrides the lift and the
          // tooltip lands on top of the point it describes.
          <motion.div
            key="tip"
            className="pointer-events-none absolute z-20"
            style={{ left: tipLeft, top: tipTop, x: '-50%', y: '-100%' }}
          >
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.15 }}
              className="w-[212px] rounded-lg border border-zinc-200 bg-white/95 px-2.5 py-2 shadow-lg backdrop-blur-sm dark:border-zinc-700 dark:bg-zinc-900/95"
            >
              <TipBody week={tip} deptCount={deptCount} delta={delta} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* The table twin: every value, readable without hover or colour. */}
      <table className="sr-only">
        <caption>KPI bonuses sent to Accounting, by week</caption>
        <thead>
          <tr>
            <th scope="col">Week</th>
            <th scope="col">Sent</th>
            <th scope="col">{noun.Many} sent</th>
            <th scope="col">Still in draft</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((w) => (
            <tr key={w.weekStart}>
              <th scope="row">{weekRange(w.weekStart)}</th>
              <td>{w.measured ? peso(w.sent) : 'Nothing saved'}</td>
              <td>
                {w.sentDepts} of {deptCount}
              </td>
              <td>{w.pending > 0 ? peso(w.pending) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TipBody({ week, deptCount, delta }: { week: TrendWeek; deptCount: number; delta: number | null }) {
  const { noun } = React.useContext(CardsContext);
  const waiting = deptCount - week.sentDepts;
  return (
    <>
      <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-zinc-500">{weekRange(week.weekStart)}</div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className="text-[13px] font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{peso(week.sent)}</span>
        {delta !== null && Number.isFinite(delta) && (
          <span className="inline-flex items-center gap-0.5 text-[10px] tabular-nums text-zinc-500">
            {delta >= 0 ? <TrendingUp className="h-3 w-3" aria-hidden /> : <TrendingDown className="h-3 w-3" aria-hidden />}
            {delta >= 0 ? '+' : ''}
            {(delta * 100).toFixed(1)}%
          </span>
        )}
      </div>
      <div className="mt-1 text-[10px] leading-snug text-zinc-500">
        <span className="block">
          {week.sentDepts} of {deptCount} {noun.many} sent · {week.sentPeople.toLocaleString('en-US')} people
        </span>
        {week.pending > 0 && <span className="block">{compactPeso(week.pending)} saved, still in draft</span>}
        {waiting - week.pendingDepts > 0 && (
          <span className="block">{waiting - week.pendingDepts} not scored at all</span>
        )}
      </div>
    </>
  );
}

function TrendCard({
  weeks,
  deptCount,
  selectedWeek,
  loading,
  failed,
  dim,
  onRetry,
  className,
}: {
  weeks: TrendWeek[];
  deptCount: number;
  selectedWeek: string;
  loading: boolean;
  failed: boolean;
  dim: boolean;
  onRetry: () => void;
  className?: string;
}) {
  const measured = weeks.filter((w) => w.measured);
  const latest = measured[measured.length - 1];
  const prior = measured[measured.length - 2];
  const avg = measured.length > 0 ? measured.reduce((s, w) => s + w.sent, 0) / measured.length : 0;
  const delta = latest && prior && prior.sent > 0 ? (latest.sent - prior.sent) / prior.sent : null;
  const latestOpen = !!latest && latest.sentDepts < deptCount;

  return (
    <CardShell
      eyebrow="Sent to Accounting · weekly"
      icon={<TrendingUp className="h-3 w-3" />}
      className={className}
      dim={dim}
      right={
        measured.length > 0 ? (
          <span className="font-mono text-[10px] text-zinc-500">
            {measured.length}-week avg <span className="text-zinc-700 dark:text-zinc-300">{compactPeso(avg)}</span>
          </span>
        ) : undefined
      }
    >
      {failed && measured.length === 0 ? (
        <CardError onRetry={onRetry} />
      ) : loading && weeks.length === 0 ? (
        <TrendLoading />
      ) : measured.length === 0 ? (
        <p className="flex flex-1 items-center text-xs text-zinc-500">Nothing has been sent to Accounting yet.</p>
      ) : (
        <>
          <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <AnimatedPeso
              value={latest!.sent}
              className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50"
            />
            <span className="text-[11px] text-zinc-500">
              week of {shortDate(latest!.weekStart)}
              {latestOpen && ` · ${latest!.sentDepts} of ${deptCount} sent so far`}
            </span>
            {delta !== null && (
              <span className="inline-flex items-center gap-0.5 text-[11px] tabular-nums text-zinc-500">
                {delta >= 0 ? <TrendingUp className="h-3 w-3" aria-hidden /> : <TrendingDown className="h-3 w-3" aria-hidden />}
                {delta >= 0 ? '+' : ''}
                {(delta * 100).toFixed(1)}% vs prior week
              </span>
            )}
          </div>
          <div className="mt-auto">
            <KpiSentTrendChart weeks={weeks} deptCount={deptCount} selectedWeek={selectedWeek} />
          </div>
        </>
      )}
    </CardShell>
  );
}

// -- Calculator skeleton -----------------------------------------------------------

/**
 * The row as it looks on its first fetch, for `KpiCalculatorLoading`. Same grid,
 * same shells, same loading bodies, so the calculator's placeholder reserves the
 * row's height and the grid under it does not drop when the calculator reveals.
 * The top earner's "week of" shimmers in its slot: the week is not resolved yet.
 * Render it wherever the calculator will mount
 * the real cards, and nowhere else: a reserved row that never fills is the same
 * jump in the other direction.
 */
export function KpiInsightCardsSkeleton({ calculator = 'dept' }: { calculator?: KpiInsightCalculator }) {
  const { noun } = CALCULATORS[calculator];
  return (
    <div className={INSIGHT_GRID}>
      <CardShell eyebrow={`${noun.One} spotlight`} icon={<Sparkles className="h-3 w-3" />}>
        <SpotlightLoading />
      </CardShell>
      <CardShell
        eyebrow="Top earner"
        icon={<Trophy className="h-3 w-3" />}
        right={<Skeleton className="h-2.5 w-20" />}
      >
        <TopEarnerLoading />
      </CardShell>
      <CardShell
        className="md:col-span-2"
        eyebrow="Sent to Accounting · weekly"
        icon={<TrendingUp className="h-3 w-3" />}
      >
        <TrendLoading />
      </CardShell>
    </div>
  );
}

// -- Container ---------------------------------------------------------------------

export default function KpiInsightCards({
  calculator = 'dept',
  depts,
  week,
  labelFor,
  colorFor = catalogDeptColor,
  liveKey,
  refreshing,
}: {
  /** Which calculator's grid the cards sit on: picks the endpoint, the cache
   *  surface and the word for a row. Departments by default. */
  calculator?: KpiInsightCalculator;
  /** The grid's department (or HSL branch) keys. The server re-checks every one
   *  against the session. */
  depts: string[];
  /** The week picker's week — a Sunday. Drives the top earner only. */
  week: string;
  labelFor: (key: string) => string;
  /** A row's colour, as its grid row paints it. Defaults to the catalog
   *  department colour; the HSL grid passes each branch's own. */
  colorFor?: (key: string) => string;
  /** Changes whenever the grid's live figures move (a save, a Mark Ready). Refetches
   *  after {@link LIVE_REFETCH_DEBOUNCE_MS} of quiet. */
  liveKey: string;
  /** The page's Refresh is running; its falling edge refetches immediately. */
  refreshing: boolean;
}) {
  const reduce = useReducedMotion();
  const { endpoint, surface, noun } = CALCULATORS[calculator];
  const cards = useMemo(() => ({ noun, colorFor }), [noun, colorFor]);
  const deptsKey = [...depts].sort().join(',');
  const cacheKey = KPI_CACHE_KEYS.insights(surface, week, depts);
  const [data, setData] = useState<KpiInsightsResponse | null>(() => getKpiCache<KpiInsightsResponse>(cacheKey) ?? null);
  const [dataKey, setDataKey] = useState(cacheKey);
  const [inFlight, setInFlight] = useState(false);
  const [failed, setFailed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // A different week or department set paints its own cached copy (or nothing),
  // never the previous week's figures.
  if (dataKey !== cacheKey) {
    setDataKey(cacheKey);
    setData(getKpiCache<KpiInsightsResponse>(cacheKey) ?? null);
    setFailed(false);
  }

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setInFlight(true);
    try {
      const qs = new URLSearchParams({ depts: deptsKey, week });
      const res = await fetch(`${endpoint}?${qs.toString()}`, { cache: 'no-store', signal: ctrl.signal });
      const json = (await res.json()) as KpiInsightsResponse;
      if (ctrl.signal.aborted) return;
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json);
      setFailed(false);
      setKpiCache(KPI_CACHE_KEYS.insights(surface, week, depts), json);
    } catch (e) {
      if (ctrl.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
      setFailed(true);
    } finally {
      if (abortRef.current === ctrl) {
        abortRef.current = null;
        setInFlight(false);
      }
    }
    // `depts` rides in on `deptsKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deptsKey, week, endpoint, surface]);

  // Week / department set → fetch now.
  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  // Live figures moved → one refetch after the burst settles.
  const firstLive = useRef(true);
  useEffect(() => {
    if (firstLive.current) {
      firstLive.current = false;
      return;
    }
    const t = setTimeout(() => void load(), LIVE_REFETCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey]);

  // The page's Refresh finished → refetch immediately.
  const wasRefreshing = useRef(refreshing);
  useEffect(() => {
    if (wasRefreshing.current && !refreshing) void load();
    wasRefreshing.current = refreshing;
  }, [refreshing, load]);

  const insights = data?.insights ?? null;
  const loading = inFlight && !insights;
  const dim = inFlight && !!insights;
  const retry = () => void load();

  return (
    <CardsContext.Provider value={cards}>
      <motion.div
        className={INSIGHT_GRID}
        initial={reduce ? false : 'hidden'}
        animate="show"
        variants={{ show: { transition: { staggerChildren: 0.07, delayChildren: 0.02 } } }}
        aria-label="KPI bonus insights"
      >
        <DeptSpotlightCard
          depts={insights?.depts ?? []}
          weeks={insights?.weeks ?? []}
          labelFor={labelFor}
          loading={loading || (!insights && !failed)}
          failed={failed && !insights}
          dim={dim}
          onRetry={retry}
        />
        <TopEarnerCard
          top={insights?.spotlight.top ?? []}
          tiedCount={insights?.spotlight.tiedCount ?? 0}
          peoplePaid={insights?.spotlight.peoplePaid ?? 0}
          weekTotal={insights?.spotlight.weekTotal ?? 0}
          runnerUpAmount={insights?.spotlight.runnerUpAmount ?? 0}
          week={week}
          labelFor={labelFor}
          loading={loading || (!insights && !failed)}
          failed={failed && !insights}
          dim={dim}
          onRetry={retry}
        />
        <TrendCard
          className="md:col-span-2"
          weeks={insights?.weeks ?? []}
          deptCount={data?.depts.length ?? depts.length}
          selectedWeek={week}
          loading={loading || (!insights && !failed)}
          failed={failed && !insights}
          dim={dim}
          onRetry={retry}
        />
      </motion.div>
    </CardsContext.Provider>
  );
}
