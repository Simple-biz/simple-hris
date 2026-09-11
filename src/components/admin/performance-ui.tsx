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
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  trendRateBand,
  type CycleTrend,
  type CycleTrendPoint,
} from '@/lib/admin/cycle-performance';
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

/* ──────────────────────────────────────────────────────────────────────────
 * The detail modal — a month card's "Open".
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Money, in the currency's own convention. Always two decimals: these figures
 * reconcile to the cent against a frozen record, and a rounded ₱12,743,165 that
 * cannot be tied back to ₱12,743,165.52 invites someone to "fix" a drift that
 * does not exist.
 */
export function money(n: number | null | undefined, currency: 'USD' | 'PHP'): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${currency === 'USD' ? '$' : '₱'}${n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * The button on a month card.
 *
 * Disabled is a STATE WITH A REASON here, never a dead control: a month with no
 * closed cycle has no frozen breakdown to show, and today that is every month
 * except August 2026. Kane chose "shown but disabled with the reason" (Q3) over
 * hiding it, so the reason has to be reachable — it rides on `title` and on
 * `aria-describedby`-free plain text, and the cursor changes so the disabled
 * state is legible before the click.
 */
export function OpenDetailButton({
  accent,
  onClick,
  disabled,
  disabledReason,
  label = 'Open',
}: {
  accent: PerfAccent;
  onClick: () => void;
  disabled?: boolean;
  disabledReason?: string;
  label?: string;
}) {
  const a = ACCENT[accent];
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={disabled ? disabledReason : 'Open the per-processor breakdown'}
      className={cn(
        'group inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10.5px] font-semibold',
        'transition-all duration-200 motion-reduce:transition-none',
        disabled
          ? 'cursor-not-allowed border-zinc-200 bg-transparent text-zinc-300 dark:border-zinc-800 dark:text-zinc-600'
          : cn(
              a.chip,
              'hover:-translate-y-px hover:shadow-sm active:translate-y-0',
              'motion-reduce:hover:translate-y-0',
            ),
      )}
    >
      {label}
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cn(
          'h-2.5 w-2.5 transition-transform duration-200 motion-reduce:transition-none',
          !disabled && 'group-hover:translate-x-0.5',
        )}
        aria-hidden
      >
        <path d="m9 18 6-6-6-6" />
      </svg>
    </button>
  );
}

/**
 * The detail popup both tabs can raise over data they ALREADY hold.
 *
 * It never fetches. That is the whole reason it can open instantly and animate
 * — there is no loading state to design, because the numbers came down with the
 * tab's own poll. If a future detail view needs its own read, it needs its own
 * loading treatment too; do not quietly add a spinner in here.
 *
 * The four dialog fixes are all present and all load-bearing
 * (`dialog-content-no-height-cap`, `docs/design/responsive-design.md`
 * § "Dialogs and modals"): the shared primitive is a `grid gap-4` with **no
 * max-height at all**, so a tall popup clips at the top AND bottom at once and
 * its footer becomes unreachable.
 *
 *   `gap-0`                          or three 16px gutters show as seams
 *   `max-h-[...]`                    or it clips at both ends on a short window
 *   `shrink-0` header                or the header compresses instead of the body
 *   `min-h-0 flex-1 overflow-y-auto` or the body cannot scroll inside the cap
 */
export function PerfDetailModal({
  open,
  onOpenChange,
  accent,
  title,
  subtitle,
  icon,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accent: PerfAccent;
  title: string;
  subtitle: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  const a = ACCENT[accent];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-1.5rem)] max-w-[calc(100%-2rem)] flex-col gap-0 p-0 sm:max-h-[92dvh] sm:max-w-3xl">
        <div className="flex shrink-0 items-center gap-2.5 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          {icon ? (
            <span
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1',
                a.text,
                a.softBg,
                a.ring,
              )}
            >
              {icon}
            </span>
          ) : null}
          <div className="min-w-0">
            <DialogTitle className="truncate text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              {title}
            </DialogTitle>
            <DialogDescription className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
              {subtitle}
            </DialogDescription>
          </div>
        </div>
        {/* min-h-0 is what lets this scroll inside the flex cap above. Without
            it the body refuses to shrink and the cap does nothing. */}
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A share-of-total bar for one row of a breakdown table.
 *
 * Deliberately NOT `RateBar`. That component draws a RATE — a measured
 * success fraction — and this one draws a SHARE of a total. Reusing it would
 * put the same visual language on two different meanings, and a reader who
 * learned that a full orange bar means "everyone got paid" would read a full
 * bar here as the same claim when it only means "this rail moved all the
 * money". Hence a thinner, quieter, unmistakably different mark.
 *
 * Animates from 0 on the next frame, like every other bar on these tabs: a
 * width set in the insertion paint has nothing to travel from. `index` staggers
 * the rows so the table resolves as a sweep instead of a snap — capped, so a
 * long table never makes the last row wait.
 */
export function ShareBar({
  share,
  accent,
  index = 0,
}: {
  /** 0–1 of the column total. */
  share: number;
  accent: PerfAccent;
  index?: number;
}) {
  const a = ACCENT[accent];
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const target = Number.isFinite(share) ? Math.max(0, Math.min(1, share)) : 0;
  return (
    <div className={cn('h-1 w-full overflow-hidden rounded-full', a.barTrack)} role="presentation">
      <div
        className={cn(
          'h-full rounded-full opacity-80 transition-[width] duration-700 ease-out motion-reduce:transition-none',
          a.bar,
        )}
        style={{
          width: `${(mounted ? target : 0) * 100}%`,
          transitionDelay: `${Math.min(index, 8) * 45}ms`,
        }}
      />
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * The per-cycle trend chart.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Why these colours and not the ones beside them.
 *
 * Measured with the dataviz palette validator on 2026-09-11, not chosen: the
 * tab's existing bar orange `#f97316` sits at **2.73:1** against the light chart
 * surface — under the 3:1 floor. `orange-600` passes on light, `orange-500` on
 * dark, so the chart steps its own hue per surface rather than flipping one
 * value.
 *
 * The no-data grey is DELIBERATELY below the chroma floor (it reads as grey, and
 * the validator flags it) because it marks an ABSENCE, not a series. Its real
 * encoding is the 45° hatch, which is also what keeps it legible under
 * colour-blindness and forced-colors. Separation from the orange passes anyway:
 * ΔE 16.0 deutan, 19.4 normal.
 */
/** What `text-orange-600` / `dark:text-orange-500` resolve to — the two values
 *  the validator was run against. Referenced by the comment above, not by the
 *  marks: every mark inherits `currentColor` so the theme switch is automatic
 *  and a hex can never drift from the class beside it. */
const TREND_STROKE_LIGHT = '#ea580c';
const TREND_STROKE_DARK = '#f97316';

/** A 45° hatch for "there is no number here". Inline: a texture, not a token. */
const HATCH: React.CSSProperties = {
  backgroundImage:
    'repeating-linear-gradient(45deg, currentColor 0 1px, transparent 1px 5px)',
  opacity: 0.28,
};

/** Each week's horizontal slot. The plot stretches past this on a wide screen. */
const MIN_SLOT_PX = 34;
const RATE_H = 104;
const PAID_H = 52;

/** "2026-08-08" → "Aug 8". Undated points never reach here — the rule drops them. */
function shortDate(dateOnly: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOnly);
  if (!m) return dateOnly;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return dateOnly;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * Width of the plot box, so the SVG can be drawn at real pixel coordinates.
 *
 * Measured rather than scaled: a `preserveAspectRatio="none"` viewBox would
 * stretch the stroke along with the geometry and the line would thin out on a
 * wide screen. Same approach as `src/components/ceo/financial-chart.tsx`, kept
 * local because extracting that hook would mean editing the CEO chart, which is
 * outside this change.
 */
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

/** A run of CONSECUTIVE weeks that all carry a value — one unbroken segment. */
interface Run {
  pts: { x: number; y: number; i: number }[];
}

/**
 * Split the series into runs, breaking wherever a week has no value.
 *
 * **This is the invariant the line form has to earn.** A single path through
 * every point would draw straight across the four weeks payroll ran outside
 * HRIS, asserting a number for each of them that nobody ever recorded. Breaking
 * the line leaves the gap visibly empty, which is the truth.
 */
function toRuns(
  values: readonly (number | null)[],
  x: (i: number) => number,
  y: (v: number) => number,
): Run[] {
  const runs: Run[] = [];
  let cur: Run['pts'] = [];
  values.forEach((v, i) => {
    if (v == null) {
      if (cur.length) runs.push({ pts: cur });
      cur = [];
      return;
    }
    cur.push({ x: x(i), y: y(v), i });
  });
  if (cur.length) runs.push({ pts: cur });
  return runs;
}

/** Straight segments, never a spline. A smoothed curve would overshoot between
 *  two weeks and imply values that no week had. */
const linePath = (pts: Run['pts']): string =>
  pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

const areaPath = (pts: Run['pts'], baseY: number): string =>
  pts.length < 2
    ? ''
    : `${linePath(pts)} L ${pts[pts.length - 1]!.x} ${baseY} L ${pts[0]!.x} ${baseY} Z`;

/**
 * Weekly success rate and people paid, one point per pay cycle.
 *
 * ── Two strips, never two axes ─────────────────────────────────────────────
 * Only 3 of 15 live weeks have a rate at all, so the rate line cannot carry a
 * progress story alone. **People paid** gets its own strip with its own axis,
 * because it has a number for every week HRIS ran and holds the real arc: ~800,
 * a four-week stop, a 330 restart, then ~1,050. Two plots sharing an x — never
 * two scales on one plot.
 *
 * ── The line breaks; it never interpolates ─────────────────────────────────
 * A week with no measurement gets no point, no segment into it and no segment
 * out of it — just the hatched band that says a week is there and a number is
 * not. That is the rule the original build satisfied by refusing the line form
 * outright (Kane, 2026-09-11, chose the line and the rule was rewritten to name
 * the behaviour instead of the shape).
 *
 * `not_run` (`paid == null`) must also stay distinct from a measured zero. One
 * is the absence of a measurement, the other is a measurement.
 *
 * ── The rate axis is NOT zero-based, and that is spent licence ─────────────
 * See {@link trendRateBand}. It is legal here only because a line encodes value
 * as position against labelled ticks. The band is drawn with visible ticks and
 * says in words that it does not start at zero. **If this ever returns to bars,
 * the band goes back to 0–100%.**
 */
export function CycleTrendChart({
  trend,
  accent,
}: {
  trend: CycleTrend;
  accent: PerfAccent;
}) {
  const a = ACCENT[accent];
  const [wrapRef, measured] = useMeasuredWidth();
  const [hover, setHover] = React.useState<number | null>(null);
  const [revealed, setRevealed] = React.useState(false);

  React.useEffect(() => {
    const id = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const { points, maxPaid, preHrisCycles, preHrisLastPeriodEnd } = trend;
  const n = points.length;
  const band = React.useMemo(() => trendRateBand(points), [points]);

  const plotW = Math.max(measured, n * MIN_SLOT_PX);
  const slot = n > 0 ? plotW / n : 0;
  const xAt = (i: number) => slot * (i + 0.5);

  const rateY = (v: number) =>
    RATE_H - ((v - band.min) / (band.max - band.min)) * RATE_H;
  const paidY = (v: number) => (maxPaid <= 0 ? PAID_H : PAID_H - (v / maxPaid) * PAID_H);

  // Not memoised: a dozen-odd points is nothing to recompute, and a memo whose
  // deps are three closures over `slot` and `band` is more to get wrong than it
  // saves.
  /**
   * Selective direct labels — never a number on every point, which is noise
   * rather than information. While the series is short every measured week is
   * worth its value; past that only the best, the worst and the newest survive.
   *
   * These are also the **contrast relief** the palette validator requires: the
   * orange sits under 3:1 against the light surface, and a WARN there is not
   * dismissable — it obligates visible labels or a table view. Both are present
   * (the per-cycle table sits directly below this chart), and removing the
   * labels does not remove the obligation.
   */
  const rated = points.filter((p) => p.rate != null);
  const labelKeys = new Set<string>(
    rated.length <= 6
      ? rated.map((p) => p.sourceFile)
      : [
          [...rated].sort((x, y) => (x.rate ?? 0) - (y.rate ?? 0))[0],
          [...rated].sort((x, y) => (y.rate ?? 0) - (x.rate ?? 0))[0],
          rated[rated.length - 1],
        ]
          .filter((p): p is CycleTrendPoint => p != null)
          .map((p) => p.sourceFile),
  );
  const rateLabels = points.map((p) =>
    p.rate != null && labelKeys.has(p.sourceFile) ? `${(p.rate * 100).toFixed(1)}%` : null,
  );

  const rateRuns = toRuns(points.map((p) => p.rate), xAt, rateY);
  const paidRuns = toRuns(points.map((p) => p.paid), xAt, paidY);

  if (n === 0) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white/80 px-3 py-6 text-center dark:border-zinc-800 dark:bg-zinc-950/40">
        <p className="text-[12px] text-zinc-500 dark:text-zinc-400">
          No pay cycle has been run through HRIS yet
          {preHrisCycles > 0 && (
            <>
              {' '}
              — {preHrisCycles} earlier {preHrisCycles === 1 ? 'week was' : 'weeks were'} paid
              another way
            </>
          )}
          .
        </p>
      </div>
    );
  }

  const bandPct = (v: number) => `${(v * 100).toFixed(0)}%`;
  const hovered = hover == null ? null : points[hover] ?? null;

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white/80 p-3 shadow-sm backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/40">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
          Every pay cycle since HRIS
        </h4>
        <TrendLegend />
      </div>

      <div className="flex gap-1.5">
        {/* Axis gutter, OUTSIDE the scroller so the ticks stay on screen while
            a long series is scrolled. */}
        <div className="flex shrink-0 flex-col items-end pr-0.5">
          <div className="relative" style={{ height: RATE_H, width: 26 }}>
            <span className="absolute right-0 top-0 -translate-y-1/2 font-mono text-[8.5px] tabular-nums text-zinc-400 dark:text-zinc-500">
              {bandPct(band.max)}
            </span>
            <span className="absolute bottom-0 right-0 translate-y-1/2 font-mono text-[8.5px] tabular-nums text-zinc-400 dark:text-zinc-500">
              {bandPct(band.min)}
            </span>
          </div>
          <div className="h-px w-full" />
          <div className="relative" style={{ height: PAID_H, width: 26 }}>
            <span className="absolute right-0 top-0 -translate-y-1/2 font-mono text-[8.5px] tabular-nums text-zinc-400 dark:text-zinc-500">
              {num(maxPaid)}
            </span>
            <span className="absolute bottom-0 right-0 translate-y-1/2 font-mono text-[8.5px] tabular-nums text-zinc-400 dark:text-zinc-500">
              0
            </span>
          </div>
        </div>

        {/* One scroller for both strips so they can never drift out of step.
            The PAGE never scrolls sideways; this box does. */}
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className="flex w-fit min-w-full items-end gap-2">
            {preHrisCycles > 0 && (
              <PreHrisBlock count={preHrisCycles} lastPeriodEnd={preHrisLastPeriodEnd} />
            )}

            <div ref={wrapRef} className="min-w-0 flex-1" style={{ minWidth: n * MIN_SLOT_PX }}>
              <div className="relative" style={{ width: plotW }}>
                <TrendPlot
                  height={RATE_H}
                  width={plotW}
                  slot={slot}
                  points={points}
                  runs={rateRuns}
                  values={points.map((p) => p.rate)}
                  revealed={revealed}
                  hover={hover}
                  onHover={setHover}
                  accent={accent}
                  gridRows={4}
                  fillOpacity={0.16}
                  labels={rateLabels}
                />
                <div className="h-px w-full bg-zinc-200 dark:bg-zinc-800" />
                <TrendPlot
                  height={PAID_H}
                  width={plotW}
                  slot={slot}
                  points={points}
                  runs={paidRuns}
                  values={points.map((p) => p.paid)}
                  revealed={revealed}
                  hover={hover}
                  onHover={setHover}
                  accent={accent}
                  gridRows={0}
                  fillOpacity={0.1}
                />

                {/* Date ticks: first, last and every fourth, so a long series
                    stays readable without collision. */}
                <div className="relative mt-0.5" style={{ height: 12 }}>
                  {points.map((p, i) =>
                    i === 0 || i === n - 1 || i % 4 === 0 ? (
                      <span
                        key={p.sourceFile}
                        className="absolute -translate-x-1/2 whitespace-nowrap font-mono text-[8.5px] tabular-nums text-zinc-400 dark:text-zinc-500"
                        style={{ left: xAt(i) }}
                      >
                        {shortDate(p.periodEnd)}
                      </span>
                    ) : null,
                  )}
                </div>

                {hovered && (
                  <TrendTooltip point={hovered} x={xAt(hover!)} accent={accent} width={plotW} />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <p className="text-[10.5px] leading-snug text-zinc-500 dark:text-zinc-400">
        Top: <strong>success rate</strong> — only a closed cycle has one, and the axis runs{' '}
        <strong>
          {bandPct(band.min)}–{bandPct(band.max)}
        </strong>
        , <em>not</em> from zero, so small differences are visible. Bottom:{' '}
        <strong>people paid</strong>, which every HRIS week has.{' '}
        <span className={a.text}>The line breaks wherever a week was not run through HRIS.</span>
      </p>
    </div>
  );
}

/**
 * One strip: hatched absence bands, gridlines, the area+line runs, the markers
 * and the hover targets.
 *
 * The line is revealed by animating `stroke-dashoffset` from its own length —
 * a draw-on, which composites and does not reflow. `motion-reduce` skips
 * straight to the finished state.
 */
function TrendPlot({
  height,
  width,
  slot,
  points,
  runs,
  values,
  revealed,
  hover,
  onHover,
  accent,
  gridRows,
  fillOpacity,
  labels,
}: {
  height: number;
  width: number;
  slot: number;
  points: readonly CycleTrendPoint[];
  runs: Run[];
  values: readonly (number | null)[];
  revealed: boolean;
  hover: number | null;
  onHover: (i: number | null) => void;
  accent: PerfAccent;
  gridRows: number;
  fillOpacity: number;
  /** Per-point direct label, or null. Same length as `points`. */
  labels?: readonly (string | null)[];
}) {
  const gradId = React.useId();
  return (
    <div className="relative" style={{ height, width }}>
      {/* Absence bands FIRST, under everything: a week with no number is still
          a week, and an empty gap would read as "this week does not exist". */}
      {values.map((v, i) =>
        v == null ? (
          <div
            key={points[i]!.sourceFile}
            className="absolute top-0 text-zinc-400 dark:text-zinc-500"
            style={{ ...HATCH, left: slot * i, width: slot, height }}
          />
        ) : null,
      )}

      <svg
        width={width}
        height={height}
        className="absolute inset-0 overflow-visible text-orange-600 dark:text-orange-500"
        aria-hidden
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity={fillOpacity * 2.6} />
            <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
          </linearGradient>
        </defs>

        {Array.from({ length: Math.max(0, gridRows - 1) }, (_, k) => {
          const y = (height / gridRows) * (k + 1);
          return (
            <line
              key={k}
              x1={0}
              x2={width}
              y1={y}
              y2={y}
              className="stroke-zinc-200 dark:stroke-zinc-800"
              strokeWidth={1}
              strokeDasharray="2 4"
            />
          );
        })}

        {runs.map((run, ri) => (
          <g key={ri}>
            {run.pts.length > 1 && (
              <>
                <path d={areaPath(run.pts, height)} fill={`url(#${gradId})`} />
                <path
                  d={linePath(run.pts)}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  // Draw-on. `pathLength` is an SVG ATTRIBUTE, not a CSS
                  // property: it normalises the dash maths so one number works
                  // for every run length, however long the path really is.
                  pathLength={1}
                  style={{
                    strokeDasharray: 1,
                    strokeDashoffset: revealed ? 0 : 1,
                    transition: 'stroke-dashoffset 900ms cubic-bezier(0.22, 1, 0.36, 1)',
                  }}
                />
              </>
            )}
            {run.pts.map((p) => (
              <circle
                key={p.i}
                cx={p.x}
                cy={p.y}
                r={hover === p.i ? 5 : 4}
                fill="currentColor"
                // The 2px SURFACE-coloured ring that separates a marker from
                // the line and from its neighbour — never a border drawn around
                // the mark, and never a fixed white, which would punch a hole in
                // the dark surface.
                className="stroke-white transition-[r] duration-150 motion-reduce:transition-none dark:stroke-zinc-950"
                strokeWidth={2}
                style={{ opacity: revealed ? 1 : 0, transition: 'opacity 300ms 500ms' }}
              />
            ))}
          </g>
        ))}
        {labels?.map((text, i) => {
          if (!text) return null;
          const v = values[i];
          if (v == null) return null;
          const run = runs.find((r) => r.pts.some((q) => q.i === i));
          const pt = run?.pts.find((q) => q.i === i);
          if (!pt) return null;
          return (
            <text
              key={points[i]!.sourceFile}
              x={pt.x}
              y={pt.y - 9}
              textAnchor="middle"
              // Text wears TEXT tokens, never the series colour — the marker
              // beside it already carries the identity.
              className="fill-zinc-500 font-mono text-[8.5px] font-semibold tabular-nums dark:fill-zinc-400"
              style={{ opacity: revealed ? 1 : 0, transition: 'opacity 300ms 600ms' }}
            >
              {text}
            </text>
          );
        })}
      </svg>

      {/* Hover targets: full-height columns, so the hit area is the whole week
          rather than an 8px dot. */}
      <div className="absolute inset-0 flex">
        {points.map((p, i) => (
          <div
            key={p.sourceFile}
            className={cn(
              'h-full min-w-0 flex-1',
              hover === i && 'bg-zinc-900/[0.035] dark:bg-white/[0.05]',
            )}
            onMouseEnter={() => onHover(i)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(i)}
            onBlur={() => onHover(null)}
            tabIndex={0}
            title={tooltipText(p)}
          />
        ))}
      </div>
    </div>
  );
}

/** The floating readout. Flips side near the right edge so it never clips. */
function TrendTooltip({
  point,
  x,
  accent,
  width,
}: {
  point: CycleTrendPoint;
  x: number;
  accent: PerfAccent;
  width: number;
}) {
  const a = ACCENT[accent];
  const flip = x > width - 120;
  return (
    <div
      className={cn(
        'pointer-events-none absolute -top-1 z-20 w-max max-w-[13rem] rounded-lg border border-zinc-200',
        'bg-white px-2 py-1.5 shadow-lg dark:border-zinc-700 dark:bg-zinc-900',
      )}
      style={{ left: x, transform: `translateX(${flip ? '-100%' : '0'})` }}
    >
      <p className="text-[10.5px] font-semibold text-zinc-900 dark:text-zinc-100">
        {point.label}
      </p>
      <p className="mt-0.5 text-[10px] leading-relaxed tabular-nums text-zinc-600 dark:text-zinc-300">
        {point.state === 'not_run' ? (
          <span className="text-zinc-500 dark:text-zinc-400">Not run through HRIS</span>
        ) : (
          <>
            {num(point.paid)} paid
            {point.state === 'closed' && point.rate != null ? (
              <>
                {' · '}
                <span className={a.text}>{(point.rate * 100).toFixed(2)}%</span>
                {point.unpaid != null && point.unpaid > 0 && (
                  <>
                    <br />
                    {num(point.unpaid)} still owed of {num(point.payable)} payable
                  </>
                )}
              </>
            ) : (
              <>
                <br />
                <span className="text-zinc-500 dark:text-zinc-400">
                  No close-out, so no rate
                </span>
              </>
            )}
          </>
        )}
      </p>
    </div>
  );
}

/** The same sentence the tooltip shows, for the native title and for a11y. */
function tooltipText(p: CycleTrendPoint): string {
  if (p.state === 'not_run') return `${p.label} — not run through HRIS`;
  if (p.state === 'closed' && p.rate != null) {
    return `${p.label} — ${(p.rate * 100).toFixed(2)}% (${p.paid} of ${p.payable} payable)`;
  }
  return `${p.label} — ${p.paid} paid, no close-out so no rate`;
}

/**
 * The collapsed era before HRIS (Kane, 2026-09-11).
 *
 * One block, not one slot per week: twelve empty slots would double the chart's
 * width and squeeze the weeks that carry data. Those weeks were paid — just not
 * through here — so the wording is neutral, matching the existing rule that
 * pre-feature weeks are never flagged as failures.
 */
function PreHrisBlock({
  count,
  lastPeriodEnd,
}: {
  count: number;
  lastPeriodEnd: string | null;
}) {
  return (
    <div className="flex shrink-0 flex-col items-center gap-1 border-r border-dashed border-zinc-200 pr-2 dark:border-zinc-800">
      <div
        className="w-11 rounded-sm text-zinc-300 dark:text-zinc-600"
        style={{ ...HATCH, height: RATE_H + PAID_H + 1 }}
      />
      <span className="max-w-[4.5rem] text-center text-[8.5px] leading-tight text-zinc-400 dark:text-zinc-500">
        No HRIS yet
        <br />
        {count} {count === 1 ? 'week' : 'weeks'}
        {lastPeriodEnd ? ` to ${shortDate(lastPeriodEnd)}` : ''}
      </span>
    </div>
  );
}

/**
 * The state legend.
 *
 * Required, not decorative: line-vs-break-vs-hatch is an IDENTITY encoding, and
 * identity must never be carried by appearance alone.
 */
function TrendLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[9.5px] text-zinc-500 dark:text-zinc-400">
      <span className="inline-flex items-center gap-1">
        <svg
          width="14"
          height="8"
          aria-hidden
          className="overflow-visible text-orange-600 dark:text-orange-500"
        >
          <line
            x1="0"
            y1="4"
            x2="14"
            y2="4"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <circle cx="7" cy="4" r="3" fill="currentColor" />
        </svg>
        Measured week
      </span>
      <span className="inline-flex items-center gap-1">
        <span
          className="h-2 w-3 rounded-[2px] text-zinc-400 dark:text-zinc-500"
          style={HATCH}
        />
        Not run through HRIS — the line breaks
      </span>
    </div>
  );
}
