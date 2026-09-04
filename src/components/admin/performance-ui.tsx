/**
 * Shared chrome for the two Diagnostics performance tabs (Payroll Cycles, HR
 * Pipeline). Presentational only — no fetching, no domain rules.
 *
 * ── Why one module ─────────────────────────────────────────────────────────
 * The two tabs are deliberately SEPARATE surfaces (Accounting's numbers and
 * HR's numbers never share a scoreboard, Kane 2026-09-04) but they must not
 * look like two different products. Accent is the only thing that differs:
 * **Accounting is orange, HR is teal.** Everything structural — card, rate bar,
 * loading modal, the "unmeasurable" treatment — is defined once here so the two
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
 * 1. **The first read raises a MODAL PROGRESS BAR** ({@link PerfLoadingModal}),
 *    not a layout skeleton (Kane, 2026-09-04). Its bar is predicted from this
 *    browser's own history and **never reaches 100% until the data lands** —
 *    the Payroll Wizard's rule, reusing its tested module. Read that
 *    component's header before touching it; the invariant is load-bearing.
 * 2. **The modal is FIRST LOAD ONLY.** A background refresh keeps the old
 *    numbers on screen and covers nothing — see `PerfShell`'s `refreshing`.
 * 3. **Every number is `tabular-nums`.** Proportional digits change width as
 *    they change value, so a polling counter visibly shivers.
 * 4. **Bars animate transform, never layout.** `scaleX` / `width` on a child
 *    inside a fixed-height track: nothing reflows, and it composites.
 * 5. **`motion-reduce:` disables all of it.** Every animated element carries
 *    the escape hatch.
 */

'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  coerceEstimate,
  foldLoadSample,
  predictedProgress,
} from '@/lib/payroll/step-load-prediction';

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
 * localStorage key holding how long each performance tab took to read last
 * time, so the bar is predicted from this browser's own history rather than a
 * guess. Same mechanism as the Payroll Wizard's step rail, separate namespace.
 */
const PERF_LOAD_MS_KEY = 'hris.diagnosticsPerf.loadMs.v1';

function readEstimate(tabKey: string): number {
  try {
    const raw = window.localStorage.getItem(PERF_LOAD_MS_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return coerceEstimate(map?.[tabKey]);
  } catch {
    // A private window, blocked site data, or a hand-edited key. The default
    // estimate is a fine answer; a broken bar is not.
    return coerceEstimate(undefined);
  }
}

function writeEstimate(tabKey: string, elapsedMs: number): void {
  try {
    const raw = window.localStorage.getItem(PERF_LOAD_MS_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    map[tabKey] = foldLoadSample(map?.[tabKey], elapsedMs);
    window.localStorage.setItem(PERF_LOAD_MS_KEY, JSON.stringify(map));
  } catch {
    // A storage failure must never break a load.
  }
}

/** How long the filled bar rests at 100% before the modal leaves. */
const SETTLE_MS = 420;

/**
 * The first-load modal. Replaces the layout skeleton these tabs shipped with
 * (Kane, 2026-09-04: *"instead of skeletons lets add a modal progress bar"*).
 *
 * ── The invariant, inherited and load-bearing ──────────────────────────────
 * **The bar never reaches 100% on prediction alone.** `predictedProgress` ramps
 * to 90% across the remembered duration, then eases asymptotically toward 99%
 * when a read overruns — so an overrun keeps showing movement instead of
 * parking at a dead 90%, without ever claiming to be finished. Only the data
 * actually landing fills it.
 *
 * That is the Payroll Wizard step rail's rule, and this reuses its exact tested
 * module rather than re-deriving the maths — `payroll-wizard-step-load.md` § 6
 * and its memory note both forbid inlining it back into a component.
 *
 * The reason applies with more force here, not less: a full bar on a payroll
 * screen is a claim that the figures behind it are safe to read. A bar that hit
 * 100% early would make that claim early.
 *
 * ── Mechanics ──────────────────────────────────────────────────────────────
 * The fill is written to `style.transform` from a rAF loop, never React state.
 * A `setState` per frame re-renders the whole tab while its own fetch saturates
 * the main thread — precisely when the bar must stay smooth. `scaleX` on a
 * fixed-size track composites; it never reflows.
 *
 * It is **dismissable**, and deliberately so. A modal that cannot be closed is a
 * trap. This one is informational: closing it does not cancel the read, and the
 * numbers arrive underneath either way.
 */
export function PerfLoadingModal({
  active,
  failed,
  accent,
  tabKey,
  title,
  detail,
}: {
  /** True while the FIRST read is in flight. Never true for a background poll. */
  active: boolean;
  /**
   * The read finished by FAILING.
   *
   * A filled bar is this component's way of saying the figures behind it are
   * safe to read. There are no figures, so the modal leaves immediately without
   * completing, and the shell's error banner — which can actually say what went
   * wrong — takes the screen. Animating to 100% and then revealing an error
   * would be the same false "done" the prediction ceiling exists to prevent.
   */
  failed: boolean;
  accent: PerfAccent;
  /** Storage key for this tab's remembered duration. */
  tabKey: string;
  title: string;
  detail: string;
}) {
  const a = ACCENT[accent];
  const [open, setOpen] = React.useState(false);
  const [landed, setLanded] = React.useState(false);
  const fillRef = React.useRef<HTMLDivElement | null>(null);
  const rafRef = React.useRef<number | null>(null);
  const startedAtRef = React.useRef<number>(0);

  const paint = React.useCallback((p: number) => {
    const el = fillRef.current;
    if (el) el.style.transform = `scaleX(${Math.max(0, Math.min(1, p))})`;
  }, []);

  const prefersReduced = React.useCallback(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
    [],
  );

  // Ramp while the read is in flight.
  React.useEffect(() => {
    if (!active) return;
    setOpen(true);
    setLanded(false);
    startedAtRef.current = performance.now();
    paint(0);

    // The ramp writes transform every frame, so the element must carry NO
    // transition while it runs — a transition would chase each frame's value
    // and lag visibly behind the true prediction. The landing adds one.
    const el = fillRef.current;
    if (el) el.style.transition = 'none';

    if (prefersReduced()) {
      // No per-frame animation. One honest, static position that still reads as
      // "working" and still cannot claim to be finished.
      paint(0.5);
      return;
    }

    const estimate = readEstimate(tabKey);
    const tick = () => {
      paint(predictedProgress(performance.now() - startedAtRef.current, estimate));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [active, tabKey, paint]);

  // The data landed: stop predicting, fill, remember the duration, leave.
  React.useEffect(() => {
    if (active || !open) return;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    // A failed read never completes the bar and never trains the estimate — a
    // read that died after 300ms is not evidence that this tab loads in 300ms.
    if (failed) {
      startedAtRef.current = 0;
      setOpen(false);
      return;
    }

    if (startedAtRef.current > 0) {
      writeEstimate(tabKey, performance.now() - startedAtRef.current);
      startedAtRef.current = 0;
    }
    setLanded(true);

    // Attach the transition and paint 1 on the NEXT frame, in that order.
    // Setting both in this tick would change `transform` in the same paint the
    // transition is declared, and the bar would JUMP to full instead of
    // travelling there — the one moment in this component that is worth
    // animating, since it is what says the figures are safe to read.
    const el = fillRef.current;
    let raf = 0;
    if (el && !prefersReduced()) {
      el.style.transition = 'transform 300ms cubic-bezier(0.22, 1, 0.36, 1)';
      raf = requestAnimationFrame(() => paint(1));
    } else {
      paint(1);
    }

    const t = setTimeout(() => setOpen(false), SETTLE_MS);
    return () => {
      clearTimeout(t);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [active, failed, open, tabKey, paint, prefersReduced]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        // `gap-0` because the shared popup is a `grid gap-4` and a `p-0` dialog
        // otherwise inherits dead gutters; the height cap because that primitive
        // ships with none at all. Both per docs/design/responsive-design.md
        // § "Dialogs and modals".
        className="flex max-h-[calc(100dvh-1.5rem)] max-w-[calc(100%-2rem)] flex-col gap-0 p-0 sm:max-w-md"
        aria-label={title}
      >
        <div className="flex flex-col gap-3.5 px-5 py-5">
          <div className="flex items-center gap-2.5">
            <span
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1',
                a.text,
                a.softBg,
                a.ring,
              )}
            >
              {landed ? <LandedGlyph /> : <ReadingGlyph />}
            </span>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
                {title}
              </p>
              <p className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
                {landed ? 'Ready.' : detail}
              </p>
            </div>
          </div>

          <div
            role="progressbar"
            aria-label={title}
            aria-busy={!landed}
            // Only the finished state announces a value. While predicting there
            // is no true percentage to announce, and reading out a guess to a
            // screen reader is worse than announcing "busy".
            {...(landed
              ? { 'aria-valuenow': 100, 'aria-valuemin': 0, 'aria-valuemax': 100 }
              : {})}
            className={cn('h-1.5 w-full overflow-hidden rounded-full', a.barTrack)}
          >
            {/* No `transform` or `transition` in the style prop: both are owned
                by the effects above, and a React-managed inline value would be
                re-asserted on every render, fighting the rAF loop. */}
            <div ref={fillRef} className={cn('h-full w-full origin-left rounded-full', a.bar)} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ReadingGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
      aria-hidden
    >
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
      <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
    </svg>
  );
}

function LandedGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
      aria-hidden
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/**
 * The shell both tabs render into: title, a live "updated" stamp, a Refresh
 * button, and the first-load/refresh distinction.
 *
 * `loading` (the FIRST read) raises {@link PerfLoadingModal}. `refreshing` (a
 * background poll) raises nothing at all: a poll that blanks or covers a screen
 * which was already correct is the jankiest thing a live dashboard can do. The
 * old numbers stay, the stamp dims, and the new ones replace them in place.
 */
export function PerfShell({
  accent,
  title,
  subtitle,
  icon,
  generatedAt,
  loading,
  loadingTitle,
  loadingDetail,
  tabKey,
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
  /** Headline inside the first-load modal — name what is being read. */
  loadingTitle: string;
  /** One quiet line under it. */
  loadingDetail: string;
  /** Storage key for this tab's remembered load duration. */
  tabKey: string;
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

      <PerfLoadingModal
        active={loading}
        failed={Boolean(error)}
        accent={accent}
        tabKey={tabKey}
        title={loadingTitle}
        detail={loadingDetail}
      />

      {/* No placeholder underneath. The modal owns the first-load moment, and a
          skeleton behind it would be two loading states for one read. */}
      {loading ? null : (
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
