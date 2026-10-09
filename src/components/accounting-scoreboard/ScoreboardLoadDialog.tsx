'use client';

/**
 * The scoreboard's loading modal (Kane, 2026-10-06: *"Onloading the dashboard lets add a progress bar
 * modal that has appropriate texts inside it please like collecting buckets and etc"* · *"make sure the
 * progress bar is accurate"*). Governing doc: docs/features/accounting-scoreboard.md § Loading the board.
 *
 * It shows ONLY when a week has nothing of it on screen: the first visit in a browser tab, or a week
 * never opened. A board painted from the browser cache, the 45 s tick and a focus stay silent.
 *
 * Accurate (load-progress.ts, on the shared step model refresh-progress.ts): one line per real piece of
 * work, done only when the server says its reads answered, saying what came back; then "Laying out
 * the board", done only once the board is painted. No percentage. The bar never goes back, and it is
 * full and green only at the end. It is the scoreboard's OWN dialog, not the table Refresh modal
 * (`table-refresh-progress.md`: that modal belongs to a Refresh button and nothing else).
 *
 * It never traps anyone: ✕ and Escape hide it while the read keeps going. A failure keeps it open with
 * the server's own sentence and Try again (ui-standards § 10.1, § 12.4).
 *
 * Motion: the fill is a Web Animations glide on `transform` (RefreshProgressDialog's technique), so a
 * re-render never restarts it. Reduced motion: the fill steps and the sheen does not run.
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { Circle, CircleAlert, CircleCheck, CircleX, LayoutGrid, LoaderCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { easingCss } from '@/lib/npd/load-progress';
import { refreshLines, refreshValueNow, type RefreshLine, type RefreshProgress } from '@/lib/refresh-progress/refresh-progress';

export interface LoadTitles {
  running: string;
  done: string;
  failed: string;
}

const reducedMotion = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function loadTitle(p: RefreshProgress, titles: LoadTitles): string {
  return p.phase === 'done' ? titles.done : p.phase === 'failed' ? titles.failed : titles.running;
}

/** What is happening now (or what stopped): the bar's value text and the live announcement. */
export function loadCurrentText(p: RefreshProgress, titles: LoadTitles): string {
  const lines = refreshLines(p);
  const at = lines.find((l) => l.state === 'failed') ?? lines.find((l) => l.state === 'current');
  if (at) return at.text;
  return loadTitle(p, titles);
}

export function ScoreboardLoadDialog({
  progress,
  titles,
  open,
  onOpenChange,
  onRetry,
}: {
  progress: RefreshProgress | null;
  titles: LoadTitles;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
}) {
  const p = progress;
  const done = p?.phase === 'done';
  const failed = p?.phase === 'failed';
  const working = !!p && !done && !failed;

  // The fill resumes the stored glide where it is NOW, so a re-render never restarts it. The popup is
  // portaled and mounts a beat after `open`, so the fill is driven from its ref callback too; until
  // then it renders empty (scaleX(0)), never full.
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
  const title = p ? loadTitle(p, titles) : titles.running;
  const valueText = p ? loadCurrentText(p, titles) : '';

  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogContent className="gap-0 sm:max-w-[420px]" data-testid="scoreboard-load-dialog" data-phase={p?.phase ?? 'idle'}>
        {p && (
          <>
            <span className="sr-only" aria-live="polite">
              {failed ? `${title}: ${p.error ?? ''}` : `${title}. ${working ? valueText : ''}`}
            </span>

            <div className="flex items-start gap-3 pr-8">
              <span
                className={cn(
                  'flex size-9 shrink-0 items-center justify-center rounded-xl ring-1',
                  done
                    ? 'bg-emerald-50 text-emerald-600 ring-emerald-100 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-900/60'
                    : failed
                      ? 'bg-rose-50 text-rose-600 ring-rose-100 dark:bg-rose-950/50 dark:text-rose-300 dark:ring-rose-900/60'
                      : 'bg-orange-50 text-orange-600 ring-orange-100 dark:bg-orange-950/50 dark:text-orange-300 dark:ring-orange-900/60',
                )}
                aria-hidden
              >
                {done ? <CircleCheck className="size-4.5" /> : failed ? <CircleAlert className="size-4.5" /> : <LayoutGrid className="size-4.5" />}
              </span>
              <div className="min-w-0">
                <DialogTitle className="text-sm leading-snug font-semibold text-zinc-900 dark:text-white">{title}</DialogTitle>
                <DialogDescription className="mt-1 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                  {done
                    ? 'Everything the team typed is on the board.'
                    : failed
                      ? 'The board stopped loading before it finished.'
                      : 'Each line ticks off when the server has sent that part of the board.'}
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
              className="relative mt-4 h-1.5 w-full overflow-hidden rounded-full bg-orange-100 dark:bg-orange-950/70"
            >
              {/* Its transform belongs to the Web Animations glide above; React never sets it mid-glide. */}
              <span
                ref={fillRef}
                aria-hidden
                data-testid="scoreboard-load-fill"
                style={{ transform: 'scaleX(0)' }}
                className={cn(
                  'absolute inset-0 origin-left overflow-hidden rounded-full will-change-transform',
                  done ? 'bg-emerald-500 dark:bg-emerald-400' : failed ? 'bg-red-500 dark:bg-red-400' : 'bg-orange-500',
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

            <ol className="mt-3.5 space-y-1.5" aria-hidden data-testid="scoreboard-load-steps">
              {lines.map((l) => (
                <li key={l.id} className="flex items-center gap-2 text-xs" data-state={l.state} data-line={l.id}>
                  <StepIcon state={l.state} />
                  <span
                    className={cn(
                      'min-w-0 truncate tabular-nums',
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
                <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-relaxed break-words text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200">
                  {p.error}
                </p>
                <DialogFooter className="mt-4">
                  <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                    Close
                  </Button>
                  <Button type="button" size="sm" onClick={onRetry}>
                    <RefreshCw className="mr-1.5 size-3.5" aria-hidden />
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
  if (state === 'done') return <CircleCheck className="size-3.5 shrink-0 text-emerald-500 dark:text-emerald-400" aria-hidden />;
  if (state === 'current') return <LoaderCircle className="size-3.5 shrink-0 animate-spin text-orange-600 motion-reduce:animate-none dark:text-orange-400" aria-hidden />;
  if (state === 'failed') return <CircleX className="size-3.5 shrink-0 text-red-500 dark:text-red-400" aria-hidden />;
  return <Circle className="size-3.5 shrink-0 text-zinc-300 dark:text-zinc-700" aria-hidden />;
}
