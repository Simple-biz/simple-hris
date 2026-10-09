'use client';

/**
 * The card over the Tasks skeleton while a board loads (Kane, 2026-10-08: "on top of the skeleton lets add the modal
 * loading similar to HRIS - NPD"). Governing doc: docs/features/accounting-scoreboard-tasks.md § Loading and the
 * browser cache. NPD's card (`NpdLoadProgress`, npd-dashboard.md § Loading a sheet) in the board's orange, on the
 * shared step model the board's own modal uses (`ScoreboardLoadDialog`, refresh-progress.ts).
 *
 * - ONLY over the skeleton: a board painted from the browser cache has no skeleton, so it has no card. One per board
 *   picked: picking another board cancels this read and its card.
 * - ACCURATE (task-load-progress.ts): one line per real read, done only when the server says it answered, saying what
 *   came back; then "Laying out the tasks", done only once the tasks are painted. No percentage. The bar never goes
 *   back, and it is full and green only at the end; "Tasks ready" holds, then the card fades.
 * - It floats (absolute, pointer-events none): nothing on the page moves, and the picker and Refresh stay usable under
 *   it. It is not a blocking dialog.
 * - On a failure it holds red where it stopped, with only the failed read's line marked; the amber box above says why
 *   and carries Try again.
 * - Motion: the fill is a Web Animations glide on `transform`, resumed from the stored glide, so a re-render never
 *   restarts it. The fade is an INLINE transition (index.css's global `*` transition rule beats Tailwind's classes).
 *   Reduced motion: the fill steps, nothing sweeps or fades.
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { Circle, CircleAlert, CircleCheck, CircleX, ListChecks, LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { easingCss } from '@/lib/npd/load-progress';
import { refreshLines, refreshValueNow, type RefreshLine, type RefreshProgress } from '@/lib/refresh-progress/refresh-progress';
import { loadCurrentText, loadTitle, type LoadTitles } from './ScoreboardLoadDialog';

/** How long "Tasks ready" stays over the board before it fades, and the fade (NPD's numbers). */
export const TASKS_CARD_HOLD_MS = 450;
export const TASKS_CARD_FADE_MS = 300;

const reducedMotion = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function TasksLoadCard({
  progress: p,
  titles,
  subtitle,
  leaving,
}: {
  progress: RefreshProgress;
  titles: LoadTitles;
  /** Whose board, under the title. */
  subtitle: string;
  /** Fading out after "Tasks ready" held. */
  leaving: boolean;
}) {
  const done = p.phase === 'done';
  const failed = p.phase === 'failed';
  const working = !done && !failed;

  // Resume the stored glide where it is NOW, so a re-render never restarts it.
  const fillRef = useRef<HTMLSpanElement>(null);
  const animRef = useRef<Animation | null>(null);
  const glide = p.glide;
  useLayoutEffect(() => {
    const el = fillRef.current;
    if (!el) return;
    animRef.current?.cancel();
    animRef.current = null;
    el.style.transform = `scaleX(${glide.to})`;
    if (glide.ms <= 0 || glide.from === glide.to || reducedMotion() || typeof el.animate !== 'function') return;
    const elapsed = now() - glide.startedAt;
    if (elapsed >= glide.ms) return;
    const a = el.animate([{ transform: `scaleX(${glide.from})` }, { transform: `scaleX(${glide.to})` }], {
      duration: glide.ms,
      easing: easingCss(glide.easing),
    });
    a.currentTime = Math.max(0, elapsed);
    animRef.current = a;
  }, [glide]);
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

  const lines = refreshLines(p);
  const title = loadTitle(p, titles);
  const valueText = loadCurrentText(p, titles);

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-6 z-20 flex justify-center px-4"
      data-testid="tasks-load-card"
      data-phase={p.phase}
      style={{
        opacity: leaving ? 0 : 1,
        transitionProperty: 'opacity',
        transitionDuration: reducedMotion() ? '0ms' : `${TASKS_CARD_FADE_MS}ms`,
        transitionTimingFunction: 'ease-out',
      }}
    >
      <div className="w-full max-w-[22rem] rounded-2xl border border-zinc-200/90 bg-white/95 p-4 shadow-[0_14px_40px_-14px_rgba(24,24,27,0.28)] backdrop-blur-sm animate-in fade-in-0 zoom-in-95 duration-200 motion-reduce:animate-none dark:border-zinc-800 dark:bg-zinc-950/95 dark:shadow-[0_14px_40px_-14px_rgba(0,0,0,0.7)]">
        <span className="sr-only" aria-live="polite">
          {failed ? `${title}: ${p.error ?? ''}` : `${title}. ${working ? valueText : ''}`}
        </span>

        <div className="flex items-center gap-3">
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
            {done ? <CircleCheck className="size-4.5" /> : failed ? <CircleAlert className="size-4.5" /> : <ListChecks className="size-4.5" />}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-zinc-900 dark:text-white">{title}</p>
            <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</p>
          </div>
        </div>

        <div
          role="progressbar"
          aria-label={title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={refreshValueNow(p)}
          aria-valuetext={valueText}
          className="relative mt-3.5 h-1.5 w-full overflow-hidden rounded-full bg-orange-100 dark:bg-orange-950/70"
        >
          {/* Its transform belongs to the Web Animations glide above; React never sets it mid-glide. */}
          <span
            ref={fillRef}
            aria-hidden
            data-testid="tasks-load-fill"
            style={{ transform: 'scaleX(0)' }}
            className={cn(
              'absolute inset-0 origin-left overflow-hidden rounded-full will-change-transform',
              done ? 'bg-emerald-500 dark:bg-emerald-400' : failed ? 'bg-red-500 dark:bg-red-400' : 'bg-orange-500',
            )}
          >
            {working ? (
              <span ref={sheenRef} className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/55 to-transparent dark:via-white/30" />
            ) : null}
          </span>
        </div>

        <ol className="mt-3.5 space-y-1.5" aria-hidden data-testid="tasks-load-steps">
          {lines.map((l) => (
            <li key={l.id} className="flex items-center gap-2 text-xs" data-state={l.state} data-line={l.id}>
              <StepIcon state={l.state} />
              <span
                className={cn(
                  'min-w-0 truncate tabular-nums',
                  l.state === 'done' && 'text-zinc-600 dark:text-zinc-400',
                  l.state === 'current' && 'font-medium text-zinc-900 dark:text-zinc-100',
                  l.state === 'todo' && 'text-zinc-400 dark:text-zinc-500',
                  l.state === 'failed' && 'font-medium text-red-700 dark:text-red-300',
                )}
              >
                {l.text}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function StepIcon({ state }: { state: RefreshLine['state'] }) {
  if (state === 'done') return <CircleCheck className="size-3.5 shrink-0 text-emerald-500 dark:text-emerald-400" aria-hidden />;
  if (state === 'current') return <LoaderCircle className="size-3.5 shrink-0 animate-spin text-orange-600 motion-reduce:animate-none dark:text-orange-400" aria-hidden />;
  if (state === 'failed') return <CircleX className="size-3.5 shrink-0 text-red-500 dark:text-red-400" aria-hidden />;
  return <Circle className="size-3.5 shrink-0 text-zinc-300 dark:text-zinc-700" aria-hidden />;
}
