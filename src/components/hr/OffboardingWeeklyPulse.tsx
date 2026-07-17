'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  Activity,
  Building2,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Minus,
  TrendingDown,
  TrendingUp,
  UserMinus,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { addWeeks, formatWeekLabel, sundayIso } from '@/lib/hr/hiring-week';
import { getHrTabCache, setHrTabCache, HR_TAB_CACHE_KEYS } from '@/lib/hr/tab-cache';

/**
 * Offboarding → "Weekly overview": two KPI cards (people offboarded + attrition
 * rate) scoped by their own Sun–Sat week selector, mirroring the HR dashboard's
 * hiring/referral week picker (adapted to the offboarding rose palette). Lives at
 * the top of the Offboarding section only.
 *
 * Separations are counted by `off_boarded_at` week, matching the trailing-window
 * attrition math the HR Overview already uses (see HrApp `OverviewBody`):
 *   avg headcount = active roster + separations / 2
 *   rate          = separations / avg headcount
 * In "By week" mode the rate is annualised (× 52) so it stays comparable to the
 * Overview's 12-month attrition thresholds; "All time" shows the raw observed
 * ratio across every recorded separation.
 */

type PulseRow = { off_boarded_at: string | null; Department: string | null };

/** Shared easing — matches the offboarding section's other motion transitions. */
const EASE = [0.22, 1, 0.36, 1] as const;
const SPARK_WEEKS = 8;

// ── House count-up (rAF, ease-out-cubic) — mirrors PaymentCatalogOverview so the
//    figures interpolate on week change and then sit perfectly still. ──────────
function useCountUp(target: number, enabled: boolean, duration = 650): number {
  const [val, setVal] = useState(enabled ? 0 : target);
  const fromRef = useRef(0);
  useEffect(() => {
    if (!enabled) {
      setVal(target);
      fromRef.current = target;
      return;
    }
    const from = fromRef.current;
    const start = performance.now();
    let raf = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setVal(from + (target - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    });
    return () => cancelAnimationFrame(raf);
  }, [target, enabled, duration]);
  return enabled ? val : target;
}

function CountInt({ value, animate }: { value: number; animate: boolean }) {
  const v = useCountUp(value, animate);
  return <>{Math.round(v).toLocaleString('en-US')}</>;
}

function CountDecimal({ value, animate, digits = 1 }: { value: number; animate: boolean; digits?: number }) {
  const v = useCountUp(value, animate);
  return <>{v.toFixed(digits)}</>;
}

/** Sun-anchored week key for a stored timestamp, or null when unparseable. */
function rowWeek(iso: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? null : sundayIso(t);
}

export default function OffboardingWeeklyPulse({
  rows,
  loading,
}: {
  rows: PulseRow[];
  loading: boolean;
}) {
  const reduce = useReducedMotion();
  const animate = !reduce;

  const [currentSunday] = useState(() => sundayIso(new Date()));
  // Default to the current week; null = "All time".
  const [week, setWeek] = useState<string | null>(() => sundayIso(new Date()));

  // Active headcount drives the attrition denominator. Seed from the shared HR
  // roster cache (populated by the Overview tab); fetch once only when cold so
  // the Offboarding tab doesn't re-pull a roster the Overview already holds.
  const [headcount, setHeadcount] = useState<number | null>(() => {
    const cached = getHrTabCache<unknown[]>(HR_TAB_CACHE_KEYS.overviewRoster);
    return Array.isArray(cached) && cached.length > 0 ? cached.length : null;
  });
  useEffect(() => {
    if (headcount != null) return;
    let alive = true;
    fetch('/api/employees', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { employees?: unknown[] }) => {
        if (!alive) return;
        const emp = j.employees ?? [];
        if (emp.length > 0) {
          setHeadcount(emp.length);
          setHrTabCache(HR_TAB_CACHE_KEYS.overviewRoster, emp);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [headcount]);

  // Separations bucketed by Sun-anchored week (one pass over the offboard rows).
  const countsByWeek = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const wk = rowWeek(r.off_boarded_at);
      if (wk) m.set(wk, (m.get(wk) ?? 0) + 1);
    }
    return m;
  }, [rows]);

  const badge = useMemo(() => {
    if (week === null) return null;
    if (week === currentSunday) return 'this week';
    if (week === addWeeks(currentSunday, -1)) return 'last week';
    return null;
  }, [week, currentSunday]);

  // Selected-period separations + previous-week comparison.
  const separations = week === null ? rows.length : countsByWeek.get(week) ?? 0;
  const prevCount = week === null ? null : countsByWeek.get(addWeeks(week, -1)) ?? 0;
  const delta = prevCount === null ? null : separations - prevCount;

  // Attrition: reuse the Overview formula. Annualise the weekly rate so it lands
  // on the same scale as the 12-month thresholds; "All time" stays observed.
  const active = headcount ?? 0;
  const avgHeadcount = active + separations / 2;
  const frac = avgHeadcount > 0 ? separations / avgHeadcount : 0;
  const displayRate = week === null ? frac * 100 : frac * 52 * 100;
  const rateKnown = headcount != null;

  const grade =
    displayRate >= 15
      ? { bar: 'from-rose-500 to-red-700', text: 'text-rose-600 dark:text-rose-400', word: 'high' }
      : displayRate >= 5
        ? { bar: 'from-amber-500 to-orange-700', text: 'text-amber-600 dark:text-amber-400', word: 'moderate' }
        : { bar: 'from-emerald-500 to-emerald-700', text: 'text-emerald-600 dark:text-emerald-400', word: 'low' };
  // Meter fills across a 0–30% window so healthy → alarming reads at a glance.
  const meterPct = Math.max(4, Math.min(100, (displayRate / 30) * 100));

  // Per-department breakdown for the selected period, ranked by count. Blank
  // departments bucket into "Unspecified" so the rows reconcile with the total.
  const deptRows = useMemo(() => {
    const inScope =
      week === null ? rows : rows.filter((r) => rowWeek(r.off_boarded_at) === week);
    const m = new Map<string, number>();
    for (const r of inScope) {
      const d = (r.Department ?? '').trim() || 'Unspecified';
      m.set(d, (m.get(d) ?? 0) + 1);
    }
    const list = Array.from(m.entries())
      .map(([dept, count]) => ({ dept, count }))
      .sort((a, b) => b.count - a.count || a.dept.localeCompare(b.dept));
    return { list, max: Math.max(1, ...list.map((d) => d.count)) };
  }, [rows, week]);

  // 8-week sparkline ending at the selected week (or the current week in All time).
  const anchor = week ?? currentSunday;
  const spark = useMemo(() => {
    const weeks: { start: string; count: number }[] = [];
    for (let i = SPARK_WEEKS - 1; i >= 0; i--) {
      const start = addWeeks(anchor, -i);
      weeks.push({ start, count: countsByWeek.get(start) ?? 0 });
    }
    const max = Math.max(1, ...weeks.map((w) => w.count));
    return { weeks, max };
  }, [anchor, countsByWeek]);

  const rateTag = week === null ? 'all-time' : 'annualized';

  return (
    <section
      className="flex flex-col gap-3"
      aria-label="Weekly offboarding overview"
    >
      {/* Header — title + the section's own week selector (rose-themed twin of
          the HR dashboard's hiring/referral picker). */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Weekly overview
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            People offboarded and the attrition rate{' '}
            {week ? `for ${formatWeekLabel(week)}` : 'across every recorded week'}.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <div className="flex items-center overflow-hidden rounded-lg border border-rose-200 dark:border-rose-900/60">
            <button
              type="button"
              onClick={() => setWeek(null)}
              aria-pressed={week === null}
              className={cn(
                'flex h-8 items-center px-2.5 text-[12px] font-medium transition-colors',
                week === null
                  ? 'bg-rose-600 text-white'
                  : 'bg-white text-rose-700 hover:bg-rose-50 dark:bg-zinc-900 dark:text-rose-300 dark:hover:bg-rose-950/40',
              )}
            >
              All time
            </button>
            <button
              type="button"
              onClick={() => setWeek((w) => w ?? currentSunday)}
              aria-pressed={week !== null}
              className={cn(
                'flex h-8 items-center px-2.5 text-[12px] font-medium transition-colors',
                week !== null
                  ? 'bg-rose-600 text-white'
                  : 'bg-white text-rose-700 hover:bg-rose-50 dark:bg-zinc-900 dark:text-rose-300 dark:hover:bg-rose-950/40',
              )}
            >
              By week
            </button>
          </div>

          {week !== null && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setWeek((w) => addWeeks(w ?? currentSunday, -1))}
                aria-label="Previous week"
                className="flex h-8 w-7 items-center justify-center rounded-lg border border-rose-200 text-rose-700 hover:bg-rose-50 dark:border-rose-900/60 dark:text-rose-300 dark:hover:bg-rose-950/40"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="flex h-8 items-center gap-1.5 rounded-lg border border-rose-200 bg-white px-2.5 text-[13px] font-medium text-zinc-800 dark:border-rose-900/60 dark:bg-zinc-900 dark:text-zinc-100">
                <CalendarClock className="h-3.5 w-3.5 text-rose-600 dark:text-rose-400" />
                <span className="tabular-nums">{formatWeekLabel(week)}</span>
                {badge && (
                  <span className="rounded-full bg-rose-100 px-1.5 py-px text-[10px] font-semibold text-rose-700 dark:bg-rose-900/50 dark:text-rose-300">
                    {badge}
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => setWeek((w) => addWeeks(w ?? currentSunday, 1))}
                disabled={week >= currentSunday}
                aria-label="Next week"
                className="flex h-8 w-7 items-center justify-center rounded-lg border border-rose-200 text-rose-700 transition-colors hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-rose-900/60 dark:text-rose-300 dark:hover:bg-rose-950/40"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* The two KPI cards. */}
      <div className="grid gap-4 sm:grid-cols-2">
        {/* ── Card 1 · Offboarded ─────────────────────────────────────────── */}
        <div className="rounded-2xl border border-rose-100/90 bg-white p-5 shadow-sm ring-1 ring-rose-500/5 dark:border-rose-950/60 dark:bg-zinc-950 dark:ring-rose-400/10">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
              <UserMinus className="h-3.5 w-3.5 text-rose-500" /> Offboarded
            </div>
            {week !== null && delta !== null && (
              <DeltaChip delta={delta} />
            )}
          </div>

          <div className="mt-2 flex items-baseline gap-2">
            {loading ? (
              <span className="inline-block h-9 w-16 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
            ) : (
              <span className="text-4xl font-bold tabular-nums leading-none text-zinc-900 dark:text-zinc-100">
                <CountInt value={separations} animate={animate} />
              </span>
            )}
            <span className="text-[13px] text-zinc-400">
              {separations === 1 ? 'person' : 'people'}
              {week === null ? ' · all weeks' : ''}
            </span>
          </div>

          {/* 8-week sparkline — bars draw up once on mount; the selected week
              stays accented and its highlight transitions as you step weeks. */}
          <div className="mt-4">
            <div className="flex h-12 items-end gap-1" aria-hidden>
              {spark.weeks.map((w, i) => {
                const h = Math.max(6, (w.count / spark.max) * 100);
                const isSel = week !== null && w.start === week;
                return (
                  <motion.div
                    key={w.start}
                    initial={animate ? { scaleY: 0, opacity: 0.4 } : false}
                    animate={{ scaleY: 1, opacity: 1 }}
                    transition={{ duration: 0.45, delay: animate ? i * 0.04 : 0, ease: EASE }}
                    style={{ height: `${h}%`, transformOrigin: 'bottom' }}
                    className={cn(
                      'flex-1 rounded-t-sm transition-colors duration-300',
                      isSel
                        ? 'bg-rose-500 dark:bg-rose-400'
                        : 'bg-rose-200/80 dark:bg-rose-900/50',
                    )}
                  />
                );
              })}
            </div>
            <p className="mt-1.5 flex items-center justify-between text-[10.5px] text-zinc-400">
              <span>{formatWeekLabel(spark.weeks[0]!.start).split(',')[0]}</span>
              <span>{SPARK_WEEKS}-week trend</span>
              <span>{formatWeekLabel(spark.weeks[SPARK_WEEKS - 1]!.start).split(',')[0]}</span>
            </p>
          </div>
        </div>

        {/* ── Card 2 · Attrition rate ─────────────────────────────────────── */}
        <div className="rounded-2xl border border-rose-100/90 bg-white p-5 shadow-sm ring-1 ring-rose-500/5 dark:border-rose-950/60 dark:bg-zinc-950 dark:ring-rose-400/10">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
              <Activity className="h-3.5 w-3.5 text-rose-500" /> Attrition rate
            </div>
            <span
              className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
              title={
                week === null
                  ? 'Recorded separations against current average headcount, across all weeks.'
                  : "This week's separations projected across a year (× 52) against average headcount: a run-rate comparable to the Overview's 12-month attrition."
              }
            >
              {rateTag}
            </span>
          </div>

          <div className="mt-2 flex items-baseline gap-2">
            {loading || !rateKnown ? (
              <span className="inline-block h-9 w-20 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
            ) : (
              <>
                <span className={cn('text-4xl font-bold tabular-nums leading-none', grade.text)}>
                  <CountDecimal value={displayRate} animate={animate} />%
                </span>
                {week !== null && <span className="text-[13px] text-zinc-400">/yr</span>}
              </>
            )}
          </div>

          <p className="mt-1.5 text-[12px] text-zinc-500 dark:text-zinc-400">
            {rateKnown ? (
              <>
                {separations} separation{separations === 1 ? '' : 's'}
                {' · ~'}
                {active.toLocaleString('en-US')} active · {grade.word}
              </>
            ) : (
              'Awaiting headcount…'
            )}
          </p>

          {/* Grade meter — width eases to the rate, colour-graded low→high. */}
          <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-900">
            <motion.div
              className={cn('h-full rounded-full bg-gradient-to-r', grade.bar)}
              initial={false}
              animate={{ width: rateKnown ? `${meterPct}%` : '0%' }}
              transition={{ duration: animate ? 0.6 : 0, ease: EASE }}
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[10.5px] text-zinc-400">
            <span>0%</span>
            <span>15%</span>
            <span>30%+</span>
          </div>
        </div>
      </div>

      {/* ── Department breakdown — full-width, its own panel so the list has room
          to spread across columns. Scoped to the same selected week. ────────── */}
      <div className="rounded-2xl border border-rose-100/90 bg-white p-5 shadow-sm ring-1 ring-rose-500/5 dark:border-rose-950/60 dark:bg-zinc-950 dark:ring-rose-400/10">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
            <Building2 className="h-3.5 w-3.5 text-rose-500" /> Offboarded by department
          </div>
          {deptRows.list.length > 0 && (
            <span className="text-[11px] tabular-nums text-zinc-400">
              {deptRows.list.length} {deptRows.list.length === 1 ? 'department' : 'departments'}
              {' · '}
              {separations} total
            </span>
          )}
        </div>

        {loading ? (
          <div className="mt-3 grid grid-cols-1 gap-x-8 gap-y-2.5 sm:grid-cols-2 xl:grid-cols-3" aria-hidden>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className="h-3 flex-1 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
                <span className="h-2 w-24 animate-pulse rounded-full bg-zinc-100 dark:bg-zinc-800" />
                <span className="h-3 w-5 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
              </div>
            ))}
          </div>
        ) : deptRows.list.length === 0 ? (
          <div className="mt-3 flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-rose-200/70 py-8 text-center dark:border-rose-900/40">
            <Building2 className="h-6 w-6 text-rose-200 dark:text-rose-900" />
            <p className="text-[13px] text-zinc-500 dark:text-zinc-400">
              No one was offboarded {week ? `in ${formatWeekLabel(week)}` : 'on record'}.
            </p>
          </div>
        ) : (
          <motion.ul
            layout={animate ? 'position' : false}
            className="mt-3 grid grid-cols-1 gap-x-8 gap-y-2.5 sm:grid-cols-2 xl:grid-cols-3"
          >
            <AnimatePresence initial={false}>
              {deptRows.list.map((d) => (
                <motion.li
                  key={d.dept}
                  layout={animate ? 'position' : false}
                  initial={animate ? { opacity: 0, y: 4 } : false}
                  animate={{ opacity: 1, y: 0 }}
                  exit={animate ? { opacity: 0 } : undefined}
                  transition={{ duration: 0.28, ease: EASE }}
                  className="flex items-center gap-3 text-[13px]"
                >
                  <span
                    className="min-w-0 flex-1 truncate text-zinc-700 dark:text-zinc-300"
                    title={d.dept}
                  >
                    {d.dept}
                  </span>
                  <span className="h-2 w-20 shrink-0 overflow-hidden rounded-full bg-rose-100/80 sm:w-24 dark:bg-rose-950/50">
                    <motion.span
                      className="block h-full rounded-full bg-gradient-to-r from-rose-400 to-rose-600 dark:from-rose-500 dark:to-rose-400"
                      initial={false}
                      animate={{ width: `${Math.max(6, (d.count / deptRows.max) * 100)}%` }}
                      transition={{ duration: animate ? 0.5 : 0, ease: EASE }}
                    />
                  </span>
                  <span className="w-6 shrink-0 text-right font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                    <CountInt value={d.count} animate={animate} />
                  </span>
                </motion.li>
              ))}
            </AnimatePresence>
          </motion.ul>
        )}
      </div>
    </section>
  );
}

/** Week-over-week change chip. For offboarding, up = more exits = concerning. */
function DeltaChip({ delta }: { delta: number }) {
  if (delta === 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
        <Minus className="h-3 w-3" /> no change
      </span>
    );
  }
  const up = delta > 0;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
        up
          ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300'
          : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
      )}
      title={`${up ? '+' : ''}${delta} vs the previous week`}
    >
      {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {up ? '+' : ''}
      {delta} vs last wk
    </span>
  );
}
