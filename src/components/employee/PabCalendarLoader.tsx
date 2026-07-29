'use client';

/**
 * Real-progress overlay for a PAB calendar's first load. Driven by the
 * calendar's actual hours-fetch progress (`progress` 0→1, climbs as each file
 * lands) so the bar genuinely TRAVELS instead of parking at a guessed ceiling. A
 * tiny time-based floor (0→15%) only covers the brief startup gap before the
 * fetch starts reporting. Snaps to 100% and fades once `done`. Live values flow
 * through refs so the rAF loop never restarts.
 *
 * Shared by the People dialog's PAB tab and the Accounting Overview's PAB
 * Calendar modals — wire it to `EmployeePabCalendar`'s `onLoadingChange` /
 * `onProgress` props and gate it with a `showLoader` flag flipped by `onDone`.
 */

import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';

export default function PabCalendarLoader({
  progress,
  done,
  barClassName,
  onDone,
}: {
  /** Real load progress 0→1 (from EmployeePabCalendar's `onProgress`). */
  progress: number;
  /** True once the calendar's initial load finished (`!loading`). */
  done: boolean;
  /** Tailwind classes for the progress bar fill, e.g. `"bg-indigo-500"`. */
  barClassName: string;
  /** Called ~180ms after the bar hits 100% — unmount the overlay here. */
  onDone: () => void;
}) {
  const reduce = useReducedMotion();
  const [pct, setPct] = useState(0);
  const progressRef = useRef(progress);
  const doneRef = useRef(done);
  const onDoneRef = useRef(onDone);
  progressRef.current = progress;
  doneRef.current = done;
  onDoneRef.current = onDone;

  useEffect(() => {
    if (reduce) {
      const id = window.setInterval(() => {
        if (doneRef.current) {
          setPct(100);
          window.clearInterval(id);
          window.setTimeout(() => onDoneRef.current(), 200);
        } else {
          setPct(Math.min(95, Math.round(progressRef.current * 95)));
        }
      }, 150);
      return () => window.clearInterval(id);
    }
    let raf = 0;
    let finished = false;
    let doneSince = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(80, now - last);
      last = now;
      setPct((p) => {
        const d = doneRef.current;
        if (d && !doneSince) doneSince = now;
        const stable = d && now - doneSince > 150;
        let next: number;
        if (stable) {
          next = p + (100 - p) * 0.25;
          if (next > 99.5) next = 100;
        } else {
          // Startup floor (→15%) keeps it moving before the hours fetch reports;
          // after that REAL file progress (progress*95) leads the bar.
          const floor = Math.min(15, p + dt * 0.03);
          const target = Math.max(floor, progressRef.current * 95);
          next = p + (target - p) * 0.16;
          if (next < p) next = p; // never go backwards
          else if (target > p && next - p < 0.06) next = p + 0.06; // a hair of motion
          if (next > 98) next = 98;
        }
        if (next >= 100 && !finished) {
          finished = true;
          window.setTimeout(() => onDoneRef.current(), 180);
        }
        return next;
      });
      if (!finished) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [reduce]);

  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center transition-opacity duration-300 motion-reduce:transition-none"
      style={{ opacity: pct >= 100 ? 0 : 1 }}
      aria-hidden
    >
      <div className="w-48 max-w-[70%] rounded-xl border border-zinc-200/80 bg-white/90 px-3.5 py-3 shadow-lg shadow-zinc-900/5 backdrop-blur-sm dark:border-zinc-800/80 dark:bg-zinc-950/90">
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">Loading…</span>
          <span className="text-[13px] font-semibold tabular-nums text-zinc-700 dark:text-zinc-200">{Math.round(pct)}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
          <div className={cn('h-full rounded-full', barClassName)} style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}
