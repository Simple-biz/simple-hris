'use client';

import type { CSSProperties } from 'react';
import { AppWindow, ChevronRight, Maximize2, PanelRight, RefreshCw, Search, Users } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

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
 * LIST (one row each, opening an overlay), a single branch renders as the
 * scoring block itself. Mirroring the wrong one is not a cosmetic miss — the
 * skeleton would reserve the wrong height and the page would jump on load.
 */
export default function KpiCalculatorLoading({
  variant = 'departments',
  title = 'My Departments',
  cards = 4,
  teamSplit = false,
}: {
  variant?: Variant;
  title?: string;
  cards?: number;
  /** The one visible HSL branch scores by sub-team (SSD Medical Records). Its
   *  workspace is far taller than a plain roster, so the placeholder has to be
   *  too — this is the shape the Payroll Readiness modal loads. */
  teamSplit?: boolean;
}) {
  const count = Math.min(Math.max(cards, 1), 8);
  return variant === 'hsl' ? (
    <HslSkeleton title={title} count={count} teamSplit={teamSplit} />
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

function HslSkeleton({ title, count, teamSplit }: { title: string; count: number; teamSplit: boolean }) {
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
            <ViewSwitchGhost />
            <Skeleton className="flex h-8 w-24 items-center justify-center gap-1.5 rounded-md">
              <RefreshCw className="h-3.5 w-3.5 text-zinc-300 dark:text-zinc-600" aria-hidden />
            </Skeleton>
          </div>
        </div>

        {/* People search + branch filter rail */}
        {multi && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full max-w-[260px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 z-10 h-3.5 w-3.5 -translate-y-1/2 text-zinc-300 dark:text-zinc-600" aria-hidden />
              <Skeleton className="h-8 w-full rounded-md" />
            </div>
            <div className="-mx-1 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-1 pb-0.5">
              {Array.from({ length: Math.min(count + 1, 6) }).map((_, i) => (
                <Skeleton key={i} className="h-7 w-20 shrink-0 rounded-full" style={{ animationDelay: `${i * 60}ms` }} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Branches. Mirrors the live split exactly: several branches are a list,
          one branch is the scoring block itself. Getting this wrong is not a
          cosmetic miss — the skeleton would reserve the wrong height and the
          page would jump when the data lands. */}
      <div className="flex flex-col gap-4 px-4 py-5 sm:px-6">
        {multi ? (
          <ul className="divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-950/50">
            {Array.from({ length: count }).map((_, i) => (
              <HslBranchRowSkeleton key={i} delay={i * 70} />
            ))}
          </ul>
        ) : (
          <HslBlockSkeleton delay={0} teamSplit={teamSplit} />
        )}
      </div>
    </div>
  );
}

/** Mirrors one `HslBranchList` row: colour bar, name over cadence + period,
 *  then status / headcount / total / chevron pushed right. */
function HslBranchRowSkeleton({ delay }: { delay: number }) {
  const at = (ms: number): CSSProperties => ({ animationDelay: `${delay + ms}ms` });
  return (
    <li className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <span className="h-8 w-1 flex-none rounded-full bg-zinc-200 dark:bg-zinc-800" aria-hidden />
      <span className="flex min-w-0 flex-[2] basis-40 flex-col gap-1.5">
        <Skeleton className="h-3.5 w-40 max-w-full" style={at(0)} />
        <Skeleton className="h-2.5 w-28 max-w-full" style={at(60)} />
      </span>
      <span className="ml-auto flex flex-none items-center gap-3">
        <Skeleton className="h-4 w-14 rounded" style={at(40)} />
        <Skeleton className="h-2.5 w-10 sm:w-16" style={at(80)} />
        <Skeleton className="h-4 w-20 sm:w-28" style={at(120)} />
        <ChevronRight className="h-4 w-4 flex-none text-zinc-200 dark:text-zinc-700" aria-hidden />
      </span>
    </li>
  );
}

/** Mirrors the single-branch `DeptBlock`: coloured left rule, header with the
 *  name + cadence/status chips + totals, then the action row, the search and
 *  paging toolbar, the scoring rows and the footer bar. */
function HslBlockSkeleton({ delay, teamSplit }: { delay: number; teamSplit: boolean }) {
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

        {teamSplit ? <SsdWorkspaceSkeleton delay={delay + 210} /> : <RosterSkeleton delay={delay + 210} />}

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

/**
 * SSD Medical Records' `SsdWorkspace`: the status strip that doubles as the team
 * tab bar, one team card beside the rules panel, then the full-width roster.
 * Reserving this shape matters more than the others — it is roughly twice the
 * height of a plain roster, so mirroring the generic one would drop the page by
 * several hundred pixels the moment the data landed.
 */
function SsdWorkspaceSkeleton({ delay }: { delay: number }) {
  const at = (ms: number): CSSProperties => ({ animationDelay: `${delay + ms}ms` });
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* Status strip / team tabs */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-zinc-200 bg-zinc-50/80 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/40">
        <div className="flex flex-none items-center gap-2 whitespace-nowrap border-r border-zinc-200 pr-4 dark:border-zinc-800">
          <Skeleton className="h-4 w-10" style={at(0)} />
          <Skeleton className="h-2.5 w-20" style={at(30)} />
        </div>
        <div className="flex min-w-0 flex-1 basis-full flex-wrap items-center gap-1.5 sm:basis-0">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-[4.5rem] flex-none rounded-full" style={at(60 + i * 50)} />
          ))}
        </div>
      </div>

      {/* Team card + rules panel */}
      <div className="grid min-w-0 items-stretch gap-4 lg:grid-cols-[minmax(0,620px)_minmax(230px,1fr)]">
        <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950/50">
          <div className="h-1 w-full bg-zinc-200 dark:bg-zinc-800" aria-hidden />
          <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
            <div className="flex items-center gap-2">
              <Skeleton className="h-2.5 w-2.5 rounded-full" style={at(360)} />
              <Skeleton className="h-3.5 w-16" style={at(380)} />
              <Skeleton className="h-2.5 w-20" style={at(400)} />
            </div>
            <Skeleton className="h-4 w-24 rounded-full" style={at(420)} />
          </div>

          {/* Three KPI fields */}
          <div className="grid gap-x-4 gap-y-3 px-4 py-4 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="min-w-0 space-y-1.5">
                <Skeleton className="h-2 w-16" style={at(440 + i * 50)} />
                <Skeleton className="h-10 w-full rounded-lg" style={at(460 + i * 50)} />
              </div>
            ))}
          </div>

          {/* Live arithmetic for the two rules */}
          <div className="space-y-1.5 border-t border-zinc-100 px-4 py-2.5 dark:border-zinc-800/70">
            <div className="flex justify-between gap-3">
              <Skeleton className="h-2.5 w-48 max-w-[60%]" style={at(610)} />
              <Skeleton className="h-2.5 w-16" style={at(620)} />
            </div>
            <div className="flex justify-between gap-3">
              <Skeleton className="h-2.5 w-40 max-w-[52%]" style={at(640)} />
              <Skeleton className="h-2.5 w-16" style={at(650)} />
            </div>
          </div>

          {/* Tier meter + per-member payout */}
          <div className="mt-auto flex items-end justify-between gap-3 border-t border-zinc-200 bg-zinc-50/70 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
            <div className="space-y-1.5">
              <div className="flex items-center gap-1" aria-hidden>
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-1.5 w-7 rounded-full" style={at(680 + i * 40)} />
                ))}
              </div>
              <Skeleton className="h-2.5 w-32" style={at(800)} />
            </div>
            <div className="space-y-1.5 text-right">
              <Skeleton className="ml-auto h-5 w-28" style={at(820)} />
              <Skeleton className="ml-auto h-2 w-16" style={at(840)} />
            </div>
          </div>
        </div>

        {/* Rules panel */}
        <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-zinc-200 bg-zinc-50/60 px-4 py-3.5 dark:border-zinc-800 dark:bg-zinc-900/30">
          <Skeleton className="h-2 w-32" style={at(460)} />
          <div className="space-y-1.5">
            <Skeleton className="h-2.5 w-36" style={at(490)} />
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-2 w-full max-w-[13rem]" style={at(520 + i * 40)} />
            ))}
          </div>
          <div className="space-y-1.5 border-t border-zinc-200 pt-2.5 dark:border-zinc-800">
            <Skeleton className="h-2.5 w-24" style={at(650)} />
            <Skeleton className="h-2 w-full max-w-[15rem]" style={at(680)} />
            <Skeleton className="h-2 w-full max-w-[11rem]" style={at(700)} />
          </div>
          <div className="mt-auto border-t border-zinc-200 pt-2.5 dark:border-zinc-800">
            <Skeleton className="h-2.5 w-44 max-w-full" style={at(730)} />
          </div>
        </div>
      </div>

      {/* Roster */}
      <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950/40">
        <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
          <Skeleton className="mr-1 h-2 w-12" style={at(860)} />
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-20 rounded-full" style={at(880 + i * 40)} />
          ))}
        </div>
        <div className="flex items-center gap-3 border-b border-zinc-200 bg-zinc-50/70 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/40">
          <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-sm" style={at(1200)} />
          <Skeleton className="h-2 w-20" style={at(1210)} />
          <Skeleton className="ml-auto h-2 w-16" style={at(1220)} />
          <Skeleton className="h-2 w-10" style={at(1230)} />
        </div>
        {Array.from({ length: 6 }).map((_, r) => (
          <div
            key={r}
            className="flex items-center gap-3 border-b border-zinc-100 px-3 py-2.5 last:border-0 dark:border-zinc-800/60"
          >
            <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-sm" style={at(1250 + r * 70)} />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-3 w-44 max-w-full" style={at(1265 + r * 70)} />
              <Skeleton className="h-2.5 w-32 max-w-full" style={at(1280 + r * 70)} />
            </div>
            <Skeleton className="h-6 w-[150px] shrink-0 rounded-full" style={at(1295 + r * 70)} />
            <Skeleton className="h-3 w-16 shrink-0" style={at(1310 + r * 70)} />
          </div>
        ))}
        <div className="flex items-center justify-between gap-2 border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <Skeleton className="h-2.5 w-24" />
          <Skeleton className="h-7 w-24 rounded-md" />
        </div>
      </div>
    </div>
  );
}
