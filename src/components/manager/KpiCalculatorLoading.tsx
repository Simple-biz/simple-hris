'use client';

import type { CSSProperties, ReactNode } from 'react';
import { AppWindow, ChevronRight, Maximize2, PanelRight, RefreshCw, Search } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { KpiInsightCardsSkeleton } from './KpiInsightCards';

type Variant = 'departments' | 'hsl';

/**
 * First-load skeleton for a KPI Calculator. Instead of a centered spinner modal,
 * it paints the calculator's actual chrome — the sticky header with title +
 * totals, the toolbar, and the branch surface — as shimmer placeholders.
 * A manager switching to the tab immediately sees the shape of the page filling
 * in (no empty/looks-broken flash), and the real content swaps straight in with
 * no layout shift once data lands.
 *
 * `variant` picks the layout to mirror (the Departments calculator vs. the HSL
 * one); `title` echoes the real header heading; `cards` is how many departments
 * the manager will see — it drives the placeholder count so the skeleton lines
 * up with what replaces it.
 *
 * The HSL variant mirrors that calculator's split: several branches render as a
 * two-column grid of rows (one row each, opening an overlay), a single branch
 * renders as the scoring block itself. Mirroring the wrong one is not a cosmetic
 * miss — the skeleton would reserve the wrong height and the page would jump on
 * load. The column count has to match the live one too, or the placeholder
 * reserves N rows where the data lands in N/2.
 *
 * `insights` reserves the insight-card row that sits between the header and the
 * grid (`KpiInsightCards`). It is over 200px tall, so leaving it out dropped the
 * whole grid when the calculator revealed. Pass it exactly where the calculator
 * will mount the cards: a reserved row that never fills is the same jump upward.
 */
export default function KpiCalculatorLoading({
  variant = 'departments',
  title = 'My Departments',
  cards = 4,
  insights = false,
  calculatorSwitch,
}: {
  variant?: Variant;
  title?: string;
  cards?: number;
  /** The calculator will paint the insight cards above its grid. */
  insights?: boolean;
  /** The HSL-Branches / Departments navigation, drawn REAL rather than as a
   *  shimmer. It has nothing to load, and since it moved inside the calculators'
   *  toolbars it would otherwise be unreachable for the whole first load —
   *  a manager who landed on the slow one could not leave it. */
  calculatorSwitch?: ReactNode;
}) {
  const count = Math.min(Math.max(cards, 1), 8);
  return variant === 'hsl' ? (
    <HslSkeleton
      title={title}
      count={count}
      insights={insights}
      calculatorSwitch={calculatorSwitch}
    />
  ) : (
    <DeptSkeleton
      title={title}
      count={count}
      single={count <= 1}
      insights={insights}
      calculatorSwitch={calculatorSwitch}
    />
  );
}

// -- Departments variant -------------------------------------------------------

function DeptSkeleton({
  title, count, single, insights, calculatorSwitch,
}: { title: string; count: number; single: boolean; insights: boolean; calculatorSwitch?: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-col" aria-busy="true" aria-label="Loading KPI Calculator">
      {/* Header + controls. Mirrors the live sticky header, which is now the
          SAME header the HSL calculator paints — one figure pill beside the
          title, then the open-as switch and Refresh; the switch and the search
          on a second row. */}
      <div className="sticky top-0 z-10 flex flex-col gap-2.5 border-b border-zinc-200/80 bg-white/90 px-5 py-3 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-950/90">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
              KPI Calculator &middot; Departments
            </p>
            <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              {title}
              {/* The "week of <date>" text — same slot as the HSL skeleton. */}
              <Skeleton className="h-3.5 w-24" />
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-28 rounded-lg" />
            <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
              <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-500">
                Projected
              </span>
              <Skeleton className="h-4 w-20" />
            </div>
            <ViewSwitchGhost />
            <Skeleton className="flex h-8 w-24 items-center justify-center gap-1.5 rounded-md">
              <RefreshCw className="h-3.5 w-3.5 text-zinc-300 dark:text-zinc-600" aria-hidden />
            </Skeleton>
          </div>
        </div>

        {/* Calculator switch + this screen's search. The live search shows
            even with one department (it finds PEOPLE too), so this does. */}
        <div className="flex flex-wrap items-center gap-2">
          {calculatorSwitch}
          <div className="relative w-full max-w-[260px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 z-10 h-3.5 w-3.5 -translate-y-1/2 text-zinc-300 dark:text-zinc-600" aria-hidden />
            <Skeleton className="h-8 w-full rounded-md" />
          </div>
        </div>
      </div>

      {insights && <KpiInsightCardsSkeleton calculator="dept" />}

      {/* Department cards */}
      <div
        className={cn(
          'grid gap-3 px-4 py-5 sm:px-6',
          single ? 'mx-auto w-full max-w-3xl grid-cols-1' : 'grid-cols-1 lg:grid-cols-2',
        )}
      >
        {Array.from({ length: count }).map((_, i) => (
          <DeptRowSkeleton key={i} delay={i * 90} />
        ))}
      </div>
    </div>
  );
}

/** Mirrors a `DeptSummaryRow`: colour bar, name over description, then status /
 *  headcount / projected / chevron pushed right. Deliberately the same shape as
 *  `HslBranchRowSkeleton` — the two calculators draw the same row now. */
function DeptRowSkeleton({ delay }: { delay: number }) {
  const at = (ms: number): CSSProperties => ({ animationDelay: `${delay + ms}ms` });
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950/50">
      <span className="h-8 w-1 flex-none rounded-full bg-zinc-200 dark:bg-zinc-800" aria-hidden />
      <span className="flex min-w-0 flex-[2] basis-40 flex-col gap-1.5">
        <Skeleton className="h-3.5 w-32 max-w-full" style={at(0)} />
        <Skeleton className="h-2.5 w-[80%] max-w-[16rem]" style={at(60)} />
      </span>
      <span className="ml-auto flex flex-none items-center gap-3">
        <Skeleton className="h-4 w-16 rounded-md" style={at(40)} />
        <Skeleton className="h-2.5 w-10 sm:w-14" style={at(80)} />
        <Skeleton className="h-4 w-20 sm:w-28" style={at(120)} />
        <ChevronRight className="h-4 w-4 flex-none text-zinc-200 dark:text-zinc-700" aria-hidden />
      </span>
    </div>
  );
}

// -- HSL variant ---------------------------------------------------------------

/** The view switch is chrome, not data — it has nothing to load and is usable
 *  the instant the calculator mounts. Drawing its real frame (rather than a
 *  shimmer block) means it doesn't move or change shape when the data lands. */
function ViewSwitchGhost() {
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-900/60">
      {[AppWindow, PanelRight, Maximize2].map((Icon, i) => (
        <span key={i} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1">
          <Icon className="h-3.5 w-3.5 text-zinc-300 dark:text-zinc-600" aria-hidden />
          <span className="hidden sm:inline">
            <Skeleton className="h-2.5 w-12" style={{ animationDelay: `${i * 60}ms` }} />
          </span>
        </span>
      ))}
    </div>
  );
}

function HslSkeleton({
  title, count, insights, calculatorSwitch,
}: { title: string; count: number; insights: boolean; calculatorSwitch?: ReactNode }) {
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
            <Skeleton className="h-8 w-28 rounded-lg" />
            <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
              <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-500">Total</span>
              <Skeleton className="h-4 w-20" />
            </div>
            <ViewSwitchGhost />
            <Skeleton className="flex h-8 w-24 items-center justify-center gap-1.5 rounded-md">
              <RefreshCw className="h-3.5 w-3.5 text-zinc-300 dark:text-zinc-600" aria-hidden />
            </Skeleton>
          </div>
        </div>

        {/* Calculator switch + people search + branch filter */}
        {(multi || calculatorSwitch) && (
          <div className="flex flex-wrap items-center gap-2">
            {calculatorSwitch}
            {multi && (
            <div className="relative w-full max-w-[260px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 z-10 h-3.5 w-3.5 -translate-y-1/2 text-zinc-300 dark:text-zinc-600" aria-hidden />
              <Skeleton className="h-8 w-full rounded-md" />
            </div>
            )}
            {/* The branch filter is one dropdown, not a rail of pills. */}
            {multi && (
              <Skeleton className="h-8 w-full max-w-[260px] rounded-md sm:w-[15rem]" style={{ animationDelay: '60ms' }} />
            )}
          </div>
        )}
      </div>

      {insights && <KpiInsightCardsSkeleton calculator="hsl" />}

      {/* Branches. Mirrors the live split exactly: several branches are two
          columns of rows, one branch is the scoring block itself. Getting this
          wrong is not a cosmetic miss — the skeleton would reserve the wrong
          height and the page would jump when the data lands. */}
      <div className="flex flex-col gap-4 px-4 py-5 sm:px-6">
        {multi ? (
          <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {Array.from({ length: count }).map((_, i) => (
              <HslBranchRowSkeleton key={i} delay={i * 70} />
            ))}
          </ul>
        ) : (
          <HslBlockSkeleton delay={0} />
        )}
      </div>
    </div>
  );
}

/** Mirrors one `HslBranchList` row: colour bar, name over cadence + period,
 *  then status / headcount / total / chevron pushed right. Two of these sit on a
 *  line from `lg`, exactly as the live grid does. */
function HslBranchRowSkeleton({ delay }: { delay: number }) {
  const at = (ms: number): CSSProperties => ({ animationDelay: `${delay + ms}ms` });
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950/50">
      <span className="h-8 w-1 flex-none rounded-full bg-zinc-200 dark:bg-zinc-800" aria-hidden />
      <span className="flex min-w-0 flex-[2] basis-40 flex-col gap-1.5">
        <Skeleton className="h-3.5 w-40 max-w-full" style={at(0)} />
        <Skeleton className="h-2.5 w-28 max-w-full" style={at(60)} />
      </span>
      <span className="ml-auto flex flex-none items-center gap-3">
        <Skeleton className="h-4 w-16 rounded-md" style={at(40)} />
        <Skeleton className="h-2.5 w-10 sm:w-14" style={at(80)} />
        <Skeleton className="h-4 w-20 sm:w-28" style={at(120)} />
        <ChevronRight className="h-4 w-4 flex-none text-zinc-200 dark:text-zinc-700" aria-hidden />
      </span>
    </li>
  );
}

/** Mirrors the single-branch `DeptBlock`: coloured left rule, header with the
 *  name + cadence/status chips + totals, then the action row, the search and
 *  paging toolbar, the scoring rows and the footer bar. */
function HslBlockSkeleton({ delay }: { delay: number }) {
  const at = (ms: number): CSSProperties => ({ animationDelay: `${delay + ms}ms` });
  return (
    <section className="overflow-hidden rounded-xl border border-l-[3px] border-zinc-200 border-l-zinc-300 bg-white shadow-sm dark:border-zinc-800 dark:border-l-zinc-700 dark:bg-zinc-950/60">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-zinc-50/70 px-5 py-3.5 dark:border-zinc-800/80 dark:bg-zinc-900/40">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <Skeleton className="h-4 w-36" style={at(0)} />
          <Skeleton className="h-3.5 w-14 rounded" style={at(50)} />
          <Skeleton className="h-3.5 w-12 rounded" style={at(80)} />
          <Skeleton className="h-2.5 w-24" style={at(110)} />
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Skeleton className="h-2.5 w-12" style={at(60)} />
          <Skeleton className="h-5 w-24" style={at(100)} />
          <Skeleton className="h-7 w-16 rounded-md" style={at(140)} />
        </div>
      </div>

      {/* Body */}
      <div className="space-y-4 px-5 py-5">
        {/* Action row: headcount + Add member */}
        <div className="flex items-center justify-between gap-2">
          <Skeleton className="h-2.5 w-20" style={at(120)} />
          <Skeleton className="h-7 w-28 rounded-md" style={at(150)} />
        </div>

        {/* Search + range toolbar */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative min-w-0 flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 z-10 h-3.5 w-3.5 -translate-y-1/2 text-zinc-300 dark:text-zinc-600" aria-hidden />
            <Skeleton className="h-8 w-full rounded-md" style={at(170)} />
          </div>
          <Skeleton className="h-3 w-24 self-end sm:self-auto" style={at(200)} />
        </div>

        <RosterSkeleton delay={delay + 210} />

        {/* Footer action bar */}
        <div className="flex items-center gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="ml-auto h-7 w-28 rounded-md" />
        </div>
      </div>
    </section>
  );
}

/** The plain scoring table most HSL branches show: a person per row with their
 *  KPI controls and running amount. */
function RosterSkeleton({ delay }: { delay: number }) {
  const at = (ms: number): CSSProperties => ({ animationDelay: `${delay + ms}ms` });
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div className="border-b border-zinc-200 bg-zinc-50/70 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/40">
        <Skeleton className="h-2.5 w-28" style={at(0)} />
      </div>
      {Array.from({ length: 5 }).map((_, r) => (
        <div
          key={r}
          className="flex items-center gap-3 border-b border-zinc-100 px-3 py-2.5 last:border-0 dark:border-zinc-800/60"
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3 w-40 max-w-full" style={at(20 + r * 70)} />
            <Skeleton className="h-2.5 w-28 max-w-full" style={at(50 + r * 70)} />
          </div>
          <Skeleton className="h-6 w-28 shrink-0 rounded-full" style={at(70 + r * 70)} />
          <Skeleton className="h-3.5 w-16 shrink-0" style={at(90 + r * 70)} />
        </div>
      ))}
    </div>
  );
}
