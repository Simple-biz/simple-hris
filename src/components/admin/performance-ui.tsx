/**
 * Shared chrome for the two Diagnostics performance tabs (Payroll Cycles, HR
 * Pipeline). Presentational only — no fetching, no domain rules.
 *
 * ── Why one module ─────────────────────────────────────────────────────────
 * The two tabs are deliberately SEPARATE surfaces (Accounting's numbers and
 * HR's numbers never share a scoreboard, Kane 2026-09-04) but they must not
 * look like two different products. Accent is the only thing that differs:
 * **Accounting is orange, HR is teal.** Everything structural — card, rate bar,
 * skeleton, the "unmeasurable" treatment — is defined once here so the two
 * cannot drift.
 *
 * ── Why those two colours specifically ─────────────────────────────────────
 * Neither is a free choice; this app's palette already carries meaning.
 *
 * - **Amber is WARNING ONLY** (`wizard-step2-header-cards`,
 *   `hsl-branch-list-and-overlay`). It cannot also be Accounting's identity —
 *   the `warn` KPI tone below is the only amber on these tabs, which is the
 *   whole point of it being amber. Accounting takes **orange**, which is what
 *   the Diagnostics header itself already uses.
 * - **Green means a verdict** in this codebase (Ready = green on the shared
 *   StatusChip). A rate bar encodes MAGNITUDE, not judgement, so a bar filling
 *   green would quietly congratulate a 40% week. HR takes **teal**, which the
 *   wizard's header cards already establish as the neutral-KPI colour ("COP
 *   teal NOT amber").
 *
 * So: no verdict colour is ever used for an identity or a magnitude here, and
 * amber is reserved for the one thing it means. Do not "brighten" either accent
 * into emerald, rose or violet without re-reading those two rules.
 *
 * ── The motion rules (Kane: "smooth UI") ───────────────────────────────────
 * 1. **The skeleton mirrors the real layout, box for box.** It is not a spinner
 *    and not a smaller placeholder: if the skeleton's grid differs from the
 *    content's grid, the page jumps when data lands. That jump is the whole
 *    thing this avoids.
 * 2. **The skeleton is FIRST LOAD ONLY.** A background refresh keeps the old
 *    numbers on screen and never blanks them — see `PerfShell`'s `refreshing`.
 * 3. **Every number is `tabular-nums`.** Proportional digits change width as
 *    they change value, so a polling counter visibly shivers.
 * 4. **Bars animate width, never layout.** `transition-[width]` on a child
 *    inside a fixed-height track: nothing reflows, and it is cheap.
 * 5. **`motion-reduce:` disables all of it.** Every animated element carries
 *    the escape hatch.
 */

'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

export type PerfAccent = 'accounting' | 'hr';

/** Accent tokens. Light-first with a dark: variant on every entry. */
export const ACCENT: Record<
  PerfAccent,
  {
    text: string;
    softBg: string;
    ring: string;
    bar: string;
    barTrack: string;
    chip: string;
    headerIcon: string;
  }
> = {
  accounting: {
    text: 'text-orange-700 dark:text-orange-400',
    softBg: 'bg-orange-50 dark:bg-orange-500/10',
    ring: 'ring-orange-100 dark:ring-orange-500/20',
    bar: 'bg-gradient-to-r from-orange-400 to-orange-500 dark:from-orange-500 dark:to-orange-600',
    barTrack: 'bg-orange-100/70 dark:bg-orange-950/50',
    chip: 'border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-900/60 dark:bg-orange-950/40 dark:text-orange-300',
    headerIcon: 'bg-gradient-to-br from-orange-500 to-orange-600 shadow-orange-500/20',
  },
  hr: {
    text: 'text-teal-700 dark:text-teal-400',
    softBg: 'bg-teal-50 dark:bg-teal-500/10',
    ring: 'ring-teal-100 dark:ring-teal-500/20',
    bar: 'bg-gradient-to-r from-teal-400 to-teal-500 dark:from-teal-500 dark:to-teal-600',
    barTrack: 'bg-teal-100/70 dark:bg-teal-950/50',
    chip: 'border-teal-200 bg-teal-50 text-teal-800 dark:border-teal-900/60 dark:bg-teal-950/40 dark:text-teal-300',
    headerIcon: 'bg-gradient-to-br from-teal-500 to-teal-700 shadow-teal-500/20',
  },
};

/**
 * A rate as a percentage string. `null` is the UNMEASURABLE case and renders an
 * em dash — never "0%", never "100%". Every caller of this must also be able to
 * explain WHY it is null; see each tab's note row.
 */
export function pct(rate: number | null | undefined, digits = 1): string {
  if (rate == null || !Number.isFinite(rate)) return '—';
  return `${(rate * 100).toFixed(digits)}%`;
}

/** Thousands separators, and a dash for absent rather than a bare 0. */
export function num(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US');
}

/**
 * One KPI card. `value` is already formatted — this component never decides
 * what a number means, only how it looks.
 */
export function KpiCard({
  label,
  value,
  sub,
  accent,
  icon,
  tone = 'accent',
  title,
}: {
  label: string;
  value: string;
  /** Muted line under the value — the supporting count, never a second KPI. */
  sub?: string | null;
  accent: PerfAccent;
  icon: React.ReactNode;
  /** 'accent' is the tab's colour; 'neutral' is a supporting count; 'warn' is a gap. */
  tone?: 'accent' | 'neutral' | 'warn';
  title?: string;
}) {
  const a = ACCENT[accent];
  return (
    <div
      title={title}
      className={cn(
        'flex items-center justify-between gap-2 rounded-xl border border-zinc-200 bg-white/80 p-3 shadow-sm backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/40',
        'transition-shadow duration-200 hover:shadow-md motion-reduce:transition-none',
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
          {label}
        </span>
        <span className="font-mono text-xl font-bold leading-none tabular-nums text-zinc-900 dark:text-zinc-100">
          {value}
        </span>
        {sub ? (
          <span className="truncate text-[11px] leading-tight tabular-nums text-zinc-500 dark:text-zinc-400">
            {sub}
          </span>
        ) : null}
      </div>
      <span
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1',
          tone === 'accent' && cn(a.text, a.softBg, a.ring),
          tone === 'neutral' &&
            'text-zinc-500 bg-zinc-50 ring-zinc-100 dark:text-zinc-400 dark:bg-zinc-900 dark:ring-zinc-800',
          tone === 'warn' &&
            'text-amber-600 bg-amber-50 ring-amber-100 dark:text-amber-400 dark:bg-amber-500/10 dark:ring-amber-500/20',
        )}
      >
        {icon}
      </span>
    </div>
  );
}

/**
 * A horizontal rate bar inside a fixed-height track.
 *
 * Mounts at 0 and animates to `rate` on the next frame, so the bar always reads
 * as filling rather than appearing. Only `width` animates — the track's box is
 * fixed, so nothing around it reflows.
 *
 * `rate === null` is UNMEASURABLE: the track renders empty with a hatched tint
 * and the caller supplies the note. An empty bar and a 0% bar look different on
 * purpose.
 */
export function RateBar({
  rate,
  accent,
  className,
  height = 'h-1.5',
}: {
  rate: number | null;
  accent: PerfAccent;
  className?: string;
  height?: string;
}) {
  const a = ACCENT[accent];
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    // Next frame, not this one: a width set in the same paint as the element's
    // insertion has nothing to transition FROM.
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const target = rate == null ? 0 : Math.max(0, Math.min(1, rate));
  return (
    <div
      className={cn('w-full overflow-hidden rounded-full', height, a.barTrack, className)}
      role="presentation"
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none',
          rate == null ? 'bg-transparent' : a.bar,
        )}
        style={{ width: `${(mounted ? target : 0) * 100}%` }}
      />
    </div>
  );
}

/** The "no percentage is honest here" pill. Never rendered next to a number. */
export function UnmeasurableChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-zinc-200 bg-zinc-50 px-1.5 py-px font-mono text-[9.5px] font-semibold uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
      {children}
    </span>
  );
}

/** A muted footnote row — the place every caveat on these tabs lives. */
export function PerfNote({
  icon,
  children,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
      {icon ? <span className="mt-px shrink-0">{icon}</span> : null}
      <span>{children}</span>
    </p>
  );
}

/** A loud, non-dismissable failure banner. A failed read is never an empty state. */
export function PerfError({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-rose-200/80 bg-rose-50/70 px-3 py-2 text-[12px] dark:border-rose-900/50 dark:bg-rose-950/30">
      <p className="leading-relaxed text-rose-900 dark:text-rose-200">
        Could not read this data — <strong>no rate is shown</strong>, because an empty
        series and a failed read are not the same thing.{' '}
        <span className="font-mono text-[11px]">{message}</span>
      </p>
    </div>
  );
}

/**
 * First-load skeleton. Mirrors the tabs' real grid: a 4-up KPI row, a band of
 * month cards, then a table. Same gaps, same heights, same rounding — so the
 * swap to real content moves nothing.
 */
export function PerfSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-live="polite">
      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="flex items-center justify-between gap-2 rounded-xl border border-zinc-200 bg-white/80 p-3 dark:border-zinc-800 dark:bg-zinc-950/40"
          >
            <div className="flex min-w-0 flex-col gap-1.5">
              <Skeleton className="h-2 w-20" />
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-2 w-24" />
            </div>
            <Skeleton className="h-8 w-8 rounded-lg" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3 xl:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white/80 p-3 dark:border-zinc-800 dark:bg-zinc-950/40"
          >
            <Skeleton className="h-2.5 w-24" />
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-1.5 w-full rounded-full" />
            <Skeleton className="h-2 w-32" />
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-zinc-200 bg-white/80 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
        <Skeleton className="mb-3 h-2.5 w-28" />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-3 py-2">
            <Skeleton className="h-3 w-36" />
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="h-3 w-12" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The shell both tabs render into: title, a live "updated" stamp, a Refresh
 * button, and the first-load/refresh distinction.
 *
 * `refreshing` deliberately does NOT swap in the skeleton. A background poll
 * that blanks the screen is the jankiest thing a live dashboard can do — the
 * old numbers stay, the stamp dims, and the new numbers replace them in place.
 */
export function PerfShell({
  accent,
  title,
  subtitle,
  icon,
  generatedAt,
  loading,
  refreshing,
  error,
  onRefresh,
  children,
}: {
  accent: PerfAccent;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  generatedAt: string | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  onRefresh: () => void;
  children: React.ReactNode;
}) {
  const a = ACCENT[accent];
  const stamp = generatedAt ? new Date(generatedAt).toLocaleTimeString() : '—';

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-2.5">
          <div
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white shadow-sm',
              a.headerIcon,
            )}
          >
            {icon}
          </div>
          <div className="min-w-0">
            <h3 className="text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              {title}
            </h3>
            <p className="mt-0.5 max-w-2xl text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
              {subtitle}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={cn(
              'font-mono text-[10px] uppercase tracking-wider transition-opacity duration-300 motion-reduce:transition-none',
              refreshing
                ? 'text-zinc-400 opacity-60 dark:text-zinc-500'
                : 'text-zinc-400 opacity-100 dark:text-zinc-500',
            )}
            title="When this data was read from the database"
          >
            Read {stamp}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing || loading}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2 text-[11px] font-medium text-zinc-700 transition-colors duration-150 hover:bg-zinc-50 disabled:opacity-50 motion-reduce:transition-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <RefreshGlyph spinning={refreshing} />
            Refresh
          </button>
        </div>
      </div>

      {error ? <PerfError message={error} /> : null}

      {loading ? (
        <PerfSkeleton />
      ) : (
        <div className="flex flex-col gap-3 duration-300 animate-in fade-in-0 slide-in-from-bottom-1 motion-reduce:animate-none">
          {children}
        </div>
      )}
    </div>
  );
}

function RefreshGlyph({ spinning }: { spinning: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('h-3 w-3', spinning && 'animate-spin motion-reduce:animate-none')}
      aria-hidden
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}
