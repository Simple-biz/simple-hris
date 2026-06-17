'use client';

import type { CSSProperties } from 'react';
import { ChevronRight, RefreshCw, Search, Users } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

type Variant = 'departments' | 'hsl';

/**
 * First-load skeleton for a KPI Calculator. Instead of a centered spinner modal,
 * it paints the calculator's actual chrome — the sticky header with title +
 * totals, the toolbar, and a grid of department cards — as shimmer placeholders.
 * A manager switching to the tab immediately sees the shape of the page filling
 * in (no empty/looks-broken flash), and the real content swaps straight in with
 * no layout shift once data lands.
 *
 * `variant` picks the layout to mirror (the Departments calculator vs. the HSL
 * one); `title` echoes the real header heading; `cards` is how many departments
 * the manager will see — it drives the placeholder grid so the skeleton lines up
 * with what replaces it.
 */
export default function KpiCalculatorLoading({
  variant = 'departments',
  title = 'My Departments',
  cards = 4,
}: {
  variant?: Variant;
  title?: string;
  cards?: number;
}) {
  const count = Math.min(Math.max(cards, 1), 8);
  return variant === 'hsl' ? (
    <HslSkeleton title={title} count={count} />
  ) : (
    <DeptSkeleton title={title} count={count} single={count <= 1} />
  );
}

// -- Departments variant -------------------------------------------------------

function DeptSkeleton({ title, count, single }: { title: string; count: number; single: boolean }) {
  return (
    <div className="flex min-h-0 flex-col" aria-busy="true" aria-label="Loading KPI Calculator">
      {/* Header + controls (mirrors the live sticky header) */}
      <div className="sticky top-0 z-10 border-b border-zinc-200/80 bg-white/85 px-4 py-3 backdrop-blur-md dark:border-zinc-800 dark:bg-[#0d1117]/85 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-400 dark:text-zinc-500">
              KPI Calculator &middot; Departments
            </p>
            <h2 className="mt-0.5 text-[18px] font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
              {title}
            </h2>
            <div className="mt-2">
              <Skeleton className="h-8 w-[230px] rounded-lg" />
            </div>
          </div>
          <div className="flex items-stretch gap-2.5">
            <div className="flex flex-col justify-center gap-1.5 rounded-xl border border-emerald-200/80 bg-gradient-to-b from-emerald-50 to-white px-3.5 py-2 text-right dark:border-emerald-900/40 dark:from-emerald-950/30 dark:to-transparent">
              <div className="font-mono text-[9px] uppercase tracking-[0.15em] text-emerald-600/80 dark:text-emerald-400/80">
                Projected &middot; week
              </div>
              <Skeleton className="ml-auto h-5 w-24" />
            </div>
            <div className="flex flex-col justify-center gap-1.5 rounded-xl border border-zinc-200 bg-zinc-50/80 px-3.5 py-2 text-right dark:border-zinc-800 dark:bg-zinc-900/60">
              <div className="font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-400">Headcount</div>
              <div className="flex items-center justify-end gap-1">
                <Users className="h-3.5 w-3.5 text-zinc-400" aria-hidden />
                <Skeleton className="h-5 w-8" />
              </div>
            </div>
          </div>
        </div>

        {/* Deadline banner placeholder */}
        <Skeleton className="mt-3 h-9 w-full rounded-lg" />

        {/* Calculators toolbar: search + open-as toggle */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="hidden font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-400 sm:inline">
              Department calculators
            </span>
            {!single && (
              <div className="relative min-w-0 max-w-[260px] flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-300" aria-hidden />
                <Skeleton className="h-8 w-full rounded-md" />
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="flex h-8 w-24 items-center justify-center gap-1.5 rounded-md">
              <RefreshCw className="h-3.5 w-3.5 text-zinc-300 dark:text-zinc-600" aria-hidden />
            </Skeleton>
            <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">Open as</span>
            <Skeleton className="h-8 w-24 rounded-lg" />
          </div>
        </div>
      </div>

      {/* Department cards */}
      <div
        className={cn(
          'grid gap-3.5 px-4 py-4 sm:px-6',
          single ? 'mx-auto w-full max-w-3xl grid-cols-1' : 'grid-cols-1 lg:grid-cols-2',
        )}
      >
        {Array.from({ length: count }).map((_, i) => (
          <DeptCardSkeleton key={i} delay={i * 90} />
        ))}
      </div>
    </div>
  );
}

/** Mirrors a `DeptSummaryCard`: thumbnail tile, identity lines, projected + chevron. */
function DeptCardSkeleton({ delay }: { delay: number }) {
  const at = (ms: number): CSSProperties => ({ animationDelay: `${delay + ms}ms` });
  return (
    <div className="relative flex items-center gap-3.5 overflow-hidden rounded-2xl border border-zinc-200/90 bg-white p-3.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="absolute inset-x-0 top-0 h-1 bg-zinc-200 dark:bg-zinc-800" aria-hidden />
      <Skeleton className="h-16 w-16 shrink-0 rounded-xl" style={at(0)} />
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-4 w-32" style={at(60)} />
        <Skeleton className="h-3 w-[80%] max-w-[16rem]" style={at(120)} />
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <div className="space-y-1.5 text-right">
          <Skeleton className="ml-auto h-2 w-12" style={at(80)} />
          <Skeleton className="ml-auto h-4 w-16" style={at(140)} />
        </div>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-200 text-zinc-300 dark:border-zinc-700 dark:text-zinc-600">
          <ChevronRight className="h-4 w-4" aria-hidden />
        </span>
      </div>
    </div>
  );
}

// -- HSL variant ---------------------------------------------------------------

function HslSkeleton({ title, count }: { title: string; count: number }) {
  const multi = count > 1;
  return (
    <div
      className="flex min-h-0 flex-col bg-gradient-to-b from-white via-blue-50/20 to-white dark:from-black dark:via-blue-950/15 dark:to-black"
      aria-busy="true"
      aria-label="Loading KPI Calculator"
    >
      {/* Top bar */}
      <div className="sticky top-0 z-10 flex flex-col gap-2.5 border-b border-zinc-200/80 bg-white/90 px-5 py-3 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-950/90">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
              KPI Calculator &middot; HSL
            </p>
            <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              {title}
              <Skeleton className="h-3.5 w-24" />
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
              <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-500">Total</span>
              <Skeleton className="h-4 w-20" />
            </div>
            <Skeleton className="flex h-8 w-24 items-center justify-center gap-1.5 rounded-md">
              <RefreshCw className="h-3.5 w-3.5 text-zinc-300 dark:text-zinc-600" aria-hidden />
            </Skeleton>
          </div>
        </div>

        {/* Department filter rail */}
        {multi && (
          <div className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-0.5">
            {Array.from({ length: Math.min(count + 1, 6) }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-20 shrink-0 rounded-full" style={{ animationDelay: `${i * 60}ms` }} />
            ))}
          </div>
        )}
      </div>

      {/* Department blocks */}
      <div
        className={cn(
          'px-4 py-5 sm:px-6',
          multi ? 'grid grid-cols-1 items-start gap-4 sm:grid-cols-2 xl:grid-cols-3' : 'flex flex-col gap-4',
        )}
      >
        {Array.from({ length: count }).map((_, i) => (
          <HslBlockSkeleton key={i} delay={i * 90} />
        ))}
      </div>
    </div>
  );
}

/** Mirrors an HSL `DeptBlock`: accent strip, header (name + status + total), score rows, action bar. */
function HslBlockSkeleton({ delay }: { delay: number }) {
  const at = (ms: number): CSSProperties => ({ animationDelay: `${delay + ms}ms` });
  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="h-1 w-full bg-zinc-200 dark:bg-zinc-800" aria-hidden />
      {/* Block header */}
      <div className="flex items-center justify-between gap-3 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800/60">
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-28" style={at(0)} />
          <Skeleton className="h-2.5 w-20" style={at(60)} />
        </div>
        <Skeleton className="h-5 w-16 rounded-full" style={at(80)} />
      </div>
      {/* Score rows */}
      <div className="px-4 py-2">
        {Array.from({ length: 4 }).map((_, r) => (
          <div
            key={r}
            className="flex items-center gap-3 border-b border-zinc-50 py-2.5 last:border-0 dark:border-zinc-800/40"
          >
            <Skeleton className="h-7 w-7 shrink-0 rounded-full" style={at(100 + r * 70)} />
            <Skeleton className="h-3.5 w-full max-w-[150px]" style={at(120 + r * 70)} />
            <Skeleton className="ml-auto h-4 w-16" style={at(140 + r * 70)} />
          </div>
        ))}
      </div>
      {/* Footer action bar */}
      <div className="flex items-center justify-between gap-2 border-t border-zinc-100 px-4 py-3 dark:border-zinc-800/60">
        <Skeleton className="h-3 w-24" />
        <div className="flex gap-2">
          <Skeleton className="h-8 w-16 rounded-md" />
          <Skeleton className="h-8 w-24 rounded-md" />
        </div>
      </div>
    </div>
  );
}
