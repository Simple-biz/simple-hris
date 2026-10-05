'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Circle, CircleAlert, CircleCheck, CircleX, LoaderCircle, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { cleanErrorMessage } from '@/lib/clean-error-message';
import { easingCss } from '@/lib/npd/load-progress';
import { cn } from '@/lib/utils';
import {
  applyRefresh,
  beginStep,
  completeStep,
  failRefresh,
  finishRefresh,
  refreshAnnouncement,
  refreshCurrentText,
  refreshLines,
  refreshTitle,
  refreshValueNow,
  startRefresh,
  type RefreshLine,
  type RefreshPlan,
  type RefreshProgress,
} from '@/lib/refresh-progress/refresh-progress';

/**
 * The modal a table's Refresh button opens (Kane, 2026-10-05: "make sure that when we refresh
 * it will not reload the table as skeleton but rather a modal with a progress bar on it and add
 * appropriate text to it"). Governing doc: docs/features/table-refresh-progress.md.
 *
 * - The table behind it is NEVER re-skeletoned: the rows on screen stay until the new ones
 *   arrive (ui-standards.md § 12.3, "a refetch never re-skeletons").
 * - ACCURATE (refresh-progress.ts): one line per read the surface really sends, done only when
 *   that read answered and saying what came back, then the page putting the rows on the table.
 *   No percentage is printed. The bar never goes back, and it is full and green only after the
 *   new rows have been committed and painted.
 * - ONLY the Refresh click opens it. A mount fetch, a poll, a realtime nudge or a reload after a
 *   save stays silent, exactly as before.
 * - It never traps anyone: ✕ and Escape hide it while the read keeps going (the table still
 *   updates when it lands). Refresh again while it runs re-opens the same run, never a second
 *   read. A failure after it was hidden is said in a toast, because nothing else would say it.
 * - A failure keeps the dialog open with the server's own sentence and Try again (§ 10.1).
 * - Motion: the fill is a Web Animations glide on `transform` (NpdLoadProgress's technique), so
 *   it stays smooth while the table re-renders. Reduced motion: the fill steps, nothing sweeps.
 */

/** Reports one of the plan's reads. Pass a promise, or a function that starts the read. */
export type RefreshTracker = {
  /**
   * Runs read `id` as its line: in progress now, done when it resolves (saying `describe(value)`,
   * e.g. "Read 42 leave requests"), failed if it rejects (the rejection still reaches the caller).
   * An id that is not in the plan throws, so a mis-wired line fails loudly instead of hanging.
   */
  step<T>(id: string, work: PromiseLike<T> | (() => PromiseLike<T>), describe?: (value: T) => string | null): Promise<T>;
  /**
   * The surface caught a failure itself (it did not throw): show this sentence. `stepId` names
   * the read that failed, so only that line is marked and a sibling still in flight is not
   * blamed; without it, every read in flight is where the refresh stopped.
   */
  fail(error: unknown, stepId?: string): void;
};

/**
 * A load shared by the Refresh click and silent paths (mount, poll, realtime, after a save):
 * runs `work` as line `id` when the click is tracking it, and just runs it otherwise, so the
 * silent paths behave exactly as before.
 */
export function trackRead<T>(
  tracker: RefreshTracker | null | undefined,
  id: string,
  work: () => PromiseLike<T>,
  describe?: (value: T) => string | null,
): Promise<T> {
  return tracker ? tracker.step(id, work, describe) : (async () => work())();
}

export type TableRefresh = {
  /**
   * Start a refresh (or re-open the one already running). `work` gets the tracker.
   * `plan` replaces the hook's plan for this run only, for a button whose subject is
   * decided at click time (one department's Refresh among many); Try again reuses it.
   */
  run: (work: (tracker: RefreshTracker) => Promise<unknown> | unknown, plan?: RefreshPlan) => void;
  /** A refresh is in flight: spin the Refresh icon and disable the button with this. */
  running: boolean;
  /** Render once, anywhere inside the surface. */
  dialog: ReactNode;
};

/** How long "Refreshed" stays before the dialog closes itself. */
const DONE_HOLD_MS = 650;

const reducedMotion = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * One refresh modal for one table. `plan` names the reads; it is read when a run starts, so an
 * inline object literal is fine. `contentClassName` reaches the portaled popup (the Tickets board
 * passes `tickets-theme dark`, ui-standards.md § 1.4).
 */
export function useTableRefresh(plan: RefreshPlan, opts: { contentClassName?: string } = {}): TableRefresh {
  const [progress, setProgress] = useState<RefreshProgress | null>(null);
  const [open, setOpen] = useState(false);
  const planRef = useRef(plan);
  planRef.current = plan;
  const openRef = useRef(open);
  openRef.current = open;
  const workRef = useRef<((tracker: RefreshTracker) => Promise<unknown> | unknown) | null>(null);
  const runPlanRef = useRef<RefreshPlan | null>(null);
  const liveRunRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const running = progress !== null && (progress.phase === 'running' || progress.phase === 'applying');
  const runningRef = useRef(running);
  runningRef.current = running;

  const start = useCallback((work: (tracker: RefreshTracker) => Promise<unknown> | unknown, planOverride?: RefreshPlan) => {
    const plan = planOverride ?? planRef.current;
    const first = startRefresh(plan, now());
    const runId = first.runId;
    liveRunRef.current = runId;
    // Before the next render, so a second click in the same frame joins this run.
    runningRef.current = true;
    workRef.current = work;
    runPlanRef.current = planOverride ?? null;
    let ended = false;
    const update = (fn: (p: RefreshProgress) => RefreshProgress) => {
      if (!mountedRef.current) return;
      setProgress((prev) => (prev && prev.runId === runId ? fn(prev) : prev));
    };
    const fail = (error: unknown, stepId?: string) => {
      if (ended) return;
      ended = true;
      const sentence = cleanErrorMessage(error, 'The refresh failed. Please try again.');
      update((p) => failRefresh(p, sentence, now(), stepId));
      // Hidden by the viewer: nothing on screen would say it failed.
      if (!openRef.current && liveRunRef.current === runId) {
        toast.error(`${refreshTitle({ ...first, phase: 'failed' })}: ${sentence}`);
      }
    };
    const known = new Set(plan.steps.map((s) => s.id));
    let answered = 0;
    const tracker: RefreshTracker = {
      async step<T>(id: string, work: PromiseLike<T> | (() => PromiseLike<T>), describe?: (value: T) => string | null): Promise<T> {
        if (!known.has(id)) {
          const err = new Error(`Refresh line "${id}" is not in this table's plan.`);
          fail(err);
          throw err;
        }
        update((p) => beginStep(p, id, now()));
        try {
          const value = await (typeof work === 'function' ? (work as () => PromiseLike<T>)() : work);
          let detail: string | null = null;
          try {
            detail = describe ? describe(value) : null;
          } catch {
            detail = null;
          }
          answered += 1;
          update((p) => completeStep(p, id, detail, now()));
          return value;
        } catch (e) {
          // Only this read failed: a sibling still in flight is not blamed for it.
          fail(e, id);
          throw e;
        }
      },
      fail: (error: unknown, stepId?: string) => fail(error, stepId !== undefined && known.has(stepId) ? stepId : undefined),
    };
    setProgress(first);
    setOpen(true);
    Promise.resolve()
      .then(() => work(tracker))
      .then(
        () => {
          if (ended) return;
          // The surface returned without reading anything (e.g. a load already in flight
          // made it skip). Saying "Table updated" would be a claim nothing backs.
          if (answered === 0) {
            fail(new Error('Nothing was read, so the table was left as it was.'));
            return;
          }
          ended = true;
          update((p) => applyRefresh(p, now()));
        },
        (e) => fail(e),
      );
  }, []);

  // Stable across renders, so a caller may put it in a dependency list.
  const run = useCallback(
    (work: (tracker: RefreshTracker) => Promise<unknown> | unknown, plan?: RefreshPlan) => {
      // A run in flight: re-open it, never send a second read.
      if (runningRef.current) {
        setOpen(true);
        return;
      }
      start(work, plan);
    },
    [start],
  );

  // The reads have answered and the surface has handed its rows to React. This effect runs
  // after the commit that holds them; one painted frame later the rows are on screen.
  const applyingRunId = progress?.phase === 'applying' ? progress.runId : null;
  useEffect(() => {
    if (applyingRunId === null) return;
    let raf = 0;
    let timer = 0;
    const finish = () => setProgress((prev) => (prev && prev.runId === applyingRunId ? finishRefresh(prev, now()) : prev));
    // A hidden browser tab paints no frames, so it gets a timer instead.
    if (typeof document !== 'undefined' && document.hidden) timer = window.setTimeout(finish, 0);
    else raf = window.requestAnimationFrame(() => {
      raf = window.requestAnimationFrame(finish);
    });
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [applyingRunId]);

  // Done: hold "Refreshed" long enough to read, then close.
  const doneRunId = progress?.phase === 'done' ? progress.runId : null;
  useEffect(() => {
    if (doneRunId === null) return;
    const t = window.setTimeout(() => setOpen(false), DONE_HOLD_MS);
    return () => window.clearTimeout(t);
  }, [doneRunId]);

  const retry = useCallback(() => {
    const work = workRef.current;
    if (work) start(work, runPlanRef.current ?? undefined);
  }, [start]);

  const dialog = useMemo(
    () => (
      <RefreshProgressDialog
        progress={progress}
        open={open && progress !== null}
        onOpenChange={setOpen}
        onRetry={retry}
        contentClassName={opts.contentClassName}
      />
    ),
    [progress, open, retry, opts.contentClassName],
  );

  return { run, running, dialog };
}

export function RefreshProgressDialog({
  progress,
  open,
  onOpenChange,
  onRetry,
  contentClassName,
}: {
  progress: RefreshProgress | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
  contentClassName?: string;
}) {
  const p = progress;
  const done = p?.phase === 'done';
  const failed = p?.phase === 'failed';
  const working = !!p && !done && !failed;

  // The fill: resume the stored glide where it is NOW, so a re-render never restarts it. The
  // popup is portaled and mounts a beat after `open`, so the fill is driven from its ref
  // callback as well as from the effect; until then it renders empty (scaleX(0)), never full.
  const glide = p?.glide ?? null;
  const glideRef = useRef(glide);
  glideRef.current = glide;
  const fillElRef = useRef<HTMLSpanElement | null>(null);
  const animRef = useRef<Animation | null>(null);
  const applyFill = useCallback((el: HTMLSpanElement) => {
    animRef.current?.cancel();
    animRef.current = null;
    const g = glideRef.current;
    if (!g) {
      el.style.transform = 'scaleX(0)';
      return;
    }
    el.style.transform = `scaleX(${g.to})`;
    if (g.ms <= 0 || g.from === g.to || reducedMotion() || typeof el.animate !== 'function') return;
    const elapsed = now() - g.startedAt;
    if (elapsed >= g.ms) return;
    const a = el.animate([{ transform: `scaleX(${g.from})` }, { transform: `scaleX(${g.to})` }], {
      duration: g.ms,
      easing: easingCss(g.easing),
    });
    a.currentTime = Math.max(0, elapsed);
    animRef.current = a;
  }, []);
  const fillRef = useCallback(
    (el: HTMLSpanElement | null) => {
      fillElRef.current = el;
      if (el) applyFill(el);
      else {
        animRef.current?.cancel();
        animRef.current = null;
      }
    },
    [applyFill],
  );
  useLayoutEffect(() => {
    if (fillElRef.current) applyFill(fillElRef.current);
  }, [glide, applyFill]);
  useEffect(() => () => animRef.current?.cancel(), []);

  // The sheen sweeps only while a read is working; it is mounted only then.
  const sheenAnimRef = useRef<Animation | null>(null);
  const sheenRef = useCallback((el: HTMLSpanElement | null) => {
    sheenAnimRef.current?.cancel();
    sheenAnimRef.current = null;
    if (!el || reducedMotion() || typeof el.animate !== 'function') return;
    sheenAnimRef.current = el.animate([{ transform: 'translateX(-120%)' }, { transform: 'translateX(320%)' }], {
      duration: 1500,
      easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
      iterations: Infinity,
    });
  }, []);

  const lines = p ? refreshLines(p) : [];
  const title = p ? refreshTitle(p) : '';
  const valueText = p ? refreshCurrentText(p) : '';

  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogContent
        className={cn('gap-0 sm:max-w-[400px]', contentClassName)}
        data-testid="refresh-progress-dialog"
        data-phase={p?.phase ?? 'idle'}
      >
        {p && (
          <>
            <span className="sr-only" aria-live="polite">
              {refreshAnnouncement(p)}
            </span>

            <div className="flex items-start gap-3 pr-8">
              <span
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1',
                  done
                    ? 'bg-emerald-50 text-emerald-600 ring-emerald-100 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-900/60'
                    : failed
                      ? 'bg-rose-50 text-rose-600 ring-rose-100 dark:bg-rose-950/50 dark:text-rose-300 dark:ring-rose-900/60'
                      : 'bg-sky-50 text-sky-600 ring-sky-100 dark:bg-sky-950/50 dark:text-sky-300 dark:ring-sky-900/60',
                )}
                aria-hidden
              >
                {done ? <CircleCheck className="h-4.5 w-4.5" /> : failed ? <CircleAlert className="h-4.5 w-4.5" /> : <RefreshCw className="h-4.5 w-4.5" />}
              </span>
              <div className="min-w-0">
                <DialogTitle className="text-sm leading-snug font-semibold text-zinc-900 dark:text-white">{title}</DialogTitle>
                <DialogDescription className="mt-1 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                  {done
                    ? 'The table now shows the latest from the server.'
                    : failed
                      ? 'The refresh stopped before it finished.'
                      : 'Getting the latest from the server. The rows already on screen stay put until the new ones are in.'}
                </DialogDescription>
              </div>
            </div>

            <div
              role="progressbar"
              aria-label={title}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={refreshValueNow(p)}
              aria-valuetext={valueText}
              className="relative mt-4 h-1.5 w-full overflow-hidden rounded-full bg-sky-100 dark:bg-sky-950/70"
            >
              {/* Its transform belongs to the Web Animations glide above; React never sets it mid-glide. */}
              <span
                ref={fillRef}
                aria-hidden
                data-testid="refresh-progress-fill"
                style={{ transform: 'scaleX(0)' }}
                className={cn(
                  'absolute inset-0 origin-left overflow-hidden rounded-full will-change-transform',
                  done ? 'bg-emerald-500 dark:bg-emerald-400' : failed ? 'bg-red-500 dark:bg-red-400' : 'bg-sky-500 dark:bg-sky-400',
                )}
              >
                {working && (
                  <span
                    ref={sheenRef}
                    className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/55 to-transparent dark:via-white/30"
                  />
                )}
              </span>
            </div>

            <ol className="mt-3.5 space-y-1.5" aria-hidden data-testid="refresh-progress-steps">
              {lines.map((l) => (
                <li key={l.id} className="flex items-center gap-2 text-xs" data-state={l.state}>
                  <StepIcon state={l.state} />
                  <span
                    className={cn(
                      'min-w-0 truncate tabular-nums',
                      // AA in both themes: zinc-400 on white is 2.8:1 (ui-standards § 11.2).
                      l.state === 'done' && 'text-zinc-600 dark:text-zinc-300',
                      l.state === 'current' && 'font-medium text-zinc-900 dark:text-zinc-100',
                      l.state === 'todo' && 'text-zinc-500 dark:text-zinc-400',
                      l.state === 'failed' && 'font-medium text-red-700 dark:text-red-300',
                    )}
                  >
                    {l.text}
                  </span>
                </li>
              ))}
            </ol>

            {failed && (
              <>
                <p
                  className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-relaxed break-words text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200"
                  data-testid="refresh-progress-error"
                >
                  {p.error}
                </p>
                <DialogFooter className="mt-4">
                  <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                    Close
                  </Button>
                  <Button type="button" size="sm" onClick={onRetry}>
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                    Try again
                  </Button>
                </DialogFooter>
              </>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StepIcon({ state }: { state: RefreshLine['state'] }) {
  if (state === 'done') return <CircleCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500 dark:text-emerald-400" aria-hidden />;
  if (state === 'current') return <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-sky-600 motion-reduce:animate-none dark:text-sky-400" aria-hidden />;
  if (state === 'failed') return <CircleX className="h-3.5 w-3.5 shrink-0 text-red-500 dark:text-red-400" aria-hidden />;
  return <Circle className="h-3.5 w-3.5 shrink-0 text-zinc-300 dark:text-zinc-700" aria-hidden />;
}
