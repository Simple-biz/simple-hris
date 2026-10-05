'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Circle, CircleCheck, CircleX, LoaderCircle, Sheet } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { NpdSheetKind } from '@/lib/npd/columns';
import { easingCss, loadAnnouncement, loadLines, loadTitle, loadValueNow, type NpdLoadLine } from '@/lib/npd/load-progress';
import { weekLabel } from '@/lib/npd/sheet';
import { clearNpdLoadProgress, npdLoadKey, useNpdLoadProgress } from './npd-sheet-loader';
import type { LoadState } from './useNpdSheet';

/**
 * The card over NPD's skeleton while a sheet loads (Kane, 2026-10-05: "on top of the
 * Skeleton, lets add a loading bar modal that has multiple loading text's that are
 * appropriate to gathering data … separate from All department and HSL … Make sure to
 * make it accurate"). Governing doc: docs/features/npd-dashboard.md § Loading a sheet.
 *
 * - ONE PER TAB × WEEK. It shows the progress of the read of the sheet on screen
 *   (npd-sheet-loader.ts), so switching tabs shows that tab's own read, where it got to.
 *   The bar resumes mid-glide from the stored numbers, never from zero.
 * - ACCURATE. Every line is a step the server reported or this page did (load-progress.ts).
 *   No percentage is printed, because inside a step the fill is an estimate; the one
 *   exact count, rows received, is printed as N of M. The bar is full and green only
 *   once the rows are on the grid, and it is only ever green after this card showed that
 *   same read loading (a cached copy never flashes "Loaded").
 * - It floats over the skeleton (absolute, pointer-events none), so nothing on the page
 *   moves and the tabs and week stepper stay usable under it. It is not a blocking
 *   dialog: you can switch tabs while it loads.
 * - Motion: the fill is a Web Animations glide on `transform` (the sync bar's technique);
 *   React never writes it mid-glide. The fade-out is an INLINE transition, because the
 *   global unlayered `*` transition rule in index.css beats Tailwind's transition classes.
 *   Reduced motion: the fill steps, nothing fades or sweeps.
 */

const TONE_ICON: Record<NpdSheetKind, string> = {
  all_departments: 'bg-sky-50 text-sky-600 ring-sky-100 dark:bg-sky-950/50 dark:text-sky-300 dark:ring-sky-900/60',
  hsl: 'bg-violet-50 text-violet-600 ring-violet-100 dark:bg-violet-950/50 dark:text-violet-300 dark:ring-violet-900/60',
};
const TRACK_TONE: Record<NpdSheetKind, string> = {
  all_departments: 'bg-sky-100 dark:bg-sky-950/70',
  hsl: 'bg-violet-100 dark:bg-violet-950/70',
};
const FILL_TONE: Record<NpdSheetKind, string> = {
  all_departments: 'bg-sky-500 dark:bg-sky-400',
  hsl: 'bg-violet-500 dark:bg-violet-400',
};
const SPIN_TONE: Record<NpdSheetKind, string> = {
  all_departments: 'text-sky-600 dark:text-sky-400',
  hsl: 'text-violet-600 dark:text-violet-400',
};

/** How long "Loaded" stays over the grid before it fades, and the fade. */
const DONE_HOLD_MS = 450;
const FADE_MS = 300;

const reducedMotion = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function NpdLoadProgress({ sheet, week, loadState }: { sheet: NpdSheetKind; week: string | null; loadState: LoadState }) {
  const key = week ? npdLoadKey(sheet, week) : null;
  const p = useNpdLoadProgress(key);
  const loading = loadState === 'loading';

  // The read this card showed loading. Only THAT read may end on "Loaded".
  const [seenLoadId, setSeenLoadId] = useState<number | null>(null);
  useEffect(() => {
    if (loading && p) setSeenLoadId(p.loadId);
  }, [loading, p]);
  const finished =
    !loading && loadState === 'ready' && !!p && p.loadId === seenLoadId && (p.step === 'layout' || p.step === 'done');

  const [leaving, setLeaving] = useState(false);
  const finishedId = finished ? p!.loadId : null;
  useEffect(() => {
    setLeaving(false);
    if (finishedId === null || !key) return;
    const reduce = reducedMotion();
    const t1 = window.setTimeout(() => setLeaving(true), DONE_HOLD_MS);
    const t2 = window.setTimeout(() => clearNpdLoadProgress(key, finishedId), DONE_HOLD_MS + (reduce ? 0 : FADE_MS));
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [finishedId, key]);

  // The fill. Read the glide from the store and resume it where it is NOW
  // (currentTime = time since it started), so a tab switched back to never restarts.
  const fillRef = useRef<HTMLSpanElement>(null);
  const sheenRef = useRef<HTMLSpanElement>(null);
  const animRef = useRef<Animation | null>(null);
  const glide = p?.glide ?? null;
  useLayoutEffect(() => {
    const el = fillRef.current;
    if (!el) return;
    animRef.current?.cancel();
    animRef.current = null;
    if (!glide) {
      el.style.transform = 'scaleX(0)';
      return;
    }
    // The rows are on the grid: it ends full, whatever the last step's ceiling was.
    const to = finished ? 1 : glide.to;
    el.style.transform = `scaleX(${to})`;
    if (glide.ms <= 0 || glide.from === to || reducedMotion() || typeof el.animate !== 'function') return;
    const elapsed = performance.now() - glide.startedAt;
    if (elapsed >= glide.ms) return;
    const a = el.animate([{ transform: `scaleX(${glide.from})` }, { transform: `scaleX(${to})` }], {
      duration: glide.ms,
      easing: easingCss(glide.easing),
    });
    a.currentTime = Math.max(0, elapsed);
    animRef.current = a;
  }, [glide, finished]);

  const visible = loading || finished;
  const working = loading && p?.step !== 'failed';
  useEffect(() => {
    const el = sheenRef.current;
    if (!el || !working || !visible || reducedMotion() || typeof el.animate !== 'function') return;
    const a = el.animate([{ transform: 'translateX(-120%)' }, { transform: 'translateX(320%)' }], {
      duration: 1500,
      easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
      iterations: Infinity,
    });
    return () => a.cancel();
  }, [working, visible]);

  useEffect(() => () => animRef.current?.cancel(), []);

  if (!visible) return null;

  const done = finished;
  const lines: NpdLoadLine[] = done
    ? loadLines(p ? { ...p, step: 'done' } : null)
    : week
      ? loadLines(p)
      : [{ step: 'open', state: 'current', text: 'Finding the newest week with a sheet' }, ...loadLines(null).slice(1)];
  const current = lines.find((l) => l.state === 'current' || l.state === 'failed') ?? lines[lines.length - 1]!;
  const title = loadTitle(sheet, done && p ? { ...p, step: 'done' } : p);

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-[6.5rem] z-20 flex justify-center px-4"
      data-testid="npd-load-progress"
      data-sheet={sheet}
      data-step={done ? 'done' : (p?.step ?? (week ? 'open' : 'week'))}
      style={{ opacity: leaving ? 0 : 1, transitionProperty: 'opacity', transitionDuration: `${FADE_MS}ms`, transitionTimingFunction: 'ease-out' }}
    >
      <div className="w-full max-w-[22rem] rounded-2xl border border-zinc-200/90 bg-white/95 p-4 shadow-[0_14px_40px_-14px_rgba(24,24,27,0.28)] backdrop-blur-sm animate-in fade-in-0 zoom-in-95 duration-200 motion-reduce:animate-none dark:border-zinc-800 dark:bg-zinc-950/95 dark:shadow-[0_14px_40px_-14px_rgba(0,0,0,0.7)]">
        <span className="sr-only" aria-live="polite">
          {loadAnnouncement(sheet, done && p ? { ...p, step: 'done' } : p)}
        </span>

        <div className="flex items-center gap-3">
          <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1', done ? 'bg-emerald-50 text-emerald-600 ring-emerald-100 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-900/60' : TONE_ICON[sheet])}>
            {done ? <CircleCheck className="h-4.5 w-4.5" /> : <Sheet className="h-4.5 w-4.5" />}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-zinc-900 dark:text-white">{title}</p>
            <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{week ? weekLabel(week) : 'Finding the week…'}</p>
          </div>
        </div>

        <div
          role="progressbar"
          aria-label={title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={done ? 100 : loadValueNow(p)}
          aria-valuetext={done ? title : current.text}
          className={cn('relative mt-3.5 h-1.5 w-full overflow-hidden rounded-full', TRACK_TONE[sheet])}
        >
          {/* Its transform belongs to the Web Animations glide above; React never sets it mid-glide. */}
          <span
            ref={fillRef}
            aria-hidden
            data-testid="npd-load-progress-fill"
            className={cn('absolute inset-0 origin-left overflow-hidden rounded-full will-change-transform', done ? 'bg-emerald-500 dark:bg-emerald-400' : p?.step === 'failed' ? 'bg-red-500 dark:bg-red-400' : FILL_TONE[sheet])}
          >
            <span
              ref={sheenRef}
              className={cn('absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/55 to-transparent dark:via-white/30', working ? 'opacity-100' : 'opacity-0')}
            />
          </span>
          {/* Before the week is known nothing is filled yet: only the sheen says it is working. */}
          {!week && (
            <span aria-hidden className="absolute inset-0 overflow-hidden rounded-full">
              <IndeterminateSheen />
            </span>
          )}
        </div>

        <ol className="mt-3.5 space-y-1.5" aria-hidden data-testid="npd-load-steps">
          {lines.map((l) => (
            <li key={l.step} className="flex items-center gap-2 text-xs" data-state={l.state}>
              <StepIcon state={l.state} sheet={sheet} />
              <span
                className={cn(
                  'min-w-0 truncate tabular-nums',
                  l.state === 'done' && 'text-zinc-600 dark:text-zinc-400',
                  l.state === 'current' && 'font-medium text-zinc-900 dark:text-zinc-100',
                  l.state === 'todo' && 'text-zinc-400 dark:text-zinc-600',
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

function StepIcon({ state, sheet }: { state: NpdLoadLine['state']; sheet: NpdSheetKind }) {
  if (state === 'done') return <CircleCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500 dark:text-emerald-400" />;
  if (state === 'current') return <LoaderCircle className={cn('h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none', SPIN_TONE[sheet])} />;
  if (state === 'failed') return <CircleX className="h-3.5 w-3.5 shrink-0 text-red-500 dark:text-red-400" />;
  return <Circle className="h-3.5 w-3.5 shrink-0 text-zinc-300 dark:text-zinc-700" />;
}

/** The track's own sweep while the week is still being found (no fill to carry a sheen yet). */
function IndeterminateSheen() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion() || typeof el.animate !== 'function') return;
    const a = el.animate([{ transform: 'translateX(-120%)' }, { transform: 'translateX(320%)' }], {
      duration: 1500,
      easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
      iterations: Infinity,
    });
    return () => a.cancel();
  }, []);
  return <span ref={ref} className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-zinc-400/50 to-transparent dark:via-zinc-500/40" />;
}
