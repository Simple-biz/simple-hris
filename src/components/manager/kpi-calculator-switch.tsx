'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export type KpiCalculatorId = 'dept' | 'hsl';

/** Departments first — it is the default, and a switch whose first tab is not
 *  the one you land on reads as a bug. */
const TABS: { id: KpiCalculatorId; label: string }[] = [
  { id: 'dept', label: 'Departments' },
  { id: 'hsl', label: 'HSL Branches' },
];

/** Must match the pill's `duration-300` below — the safety net for
 *  `transitionend` not firing (reduced motion, tab hidden). */
const TRAVEL_MS = 300;

/**
 * Where the pill last came to REST, remembered across mounts.
 *
 * This switch lives inside the calculator it navigates away from, so every
 * click unmounts it with the outgoing calculator and mounts a fresh one with the
 * incoming — and the incoming side may mount TWICE (its loading skeleton for a
 * frame, then the real calculator). A per-instance state cannot carry a position
 * across that; a module-level one can, and it is the whole trick here.
 */
let restingAt: KpiCalculatorId | null = null;

/**
 * The Departments / HSL Branches navigation. `ManagerApp` owns which calculator
 * is showing and renders ONE of these, passing the element down into whichever
 * calculator's toolbar is on screen (and into its loading skeleton).
 *
 * **The indicator has to survive a remount — several, in fact.** Three versions
 * of this have shipped on 2026-09-02:
 *
 * 1. A CSS `transition-transform` on an inline `translateX`. Could never play:
 *    the new node is born at its final position, so the pill jumped.
 * 2. A motion `layoutId` inside the active button. Animated HSL → Departments
 *    but NOT Departments → HSL (Kane: *"vice versa there is no animation"*). Switching
 *    TO HSL mounts the HSL skeleton for a frame before the real calculator, so
 *    the pill mounts twice; `layoutId` hands the second mount a snapshot that is
 *    already at the destination, and the travel is lost.
 * 3. This: the CSS transition again, but the pill is BORN where the previous
 *    instance's pill came to rest (`restingAt`, module-scoped so it outlives any
 *    instance), and moves to the active tab on the next frame. A skeleton that
 *    mounts and unmounts mid-flight never records a resting position, so the
 *    real calculator's pill simply starts the same slide from the same place.
 *    Deterministic, no measurement, no library snapshot to lose.
 *
 * The two buttons are `flex-1 basis-0` with NO gap, which is what makes each
 * exactly half the padded box and lets the pill travel a clean 100%. Reduced
 * motion is `motion-reduce:transition-none` — the pill still ends up in the
 * right place, it just does not travel.
 */
export function KpiCalculatorSwitch({
  active,
  onChange,
}: {
  active: KpiCalculatorId;
  onChange: (next: KpiCalculatorId) => void;
}) {
  // Born at the last resting position, or in place when there is none.
  const [pillAt, setPillAt] = useState<KpiCalculatorId>(() => restingAt ?? active);
  /** True from the frame the slide is committed until the pill arrives. The
   *  effect below re-runs the moment `pillAt` catches up with `active`, and that
   *  re-run must NOT record a rest — the pill has only just left. */
  const inFlight = useRef(false);
  const settleTimer = useRef<number | null>(null);

  const arrive = (at: KpiCalculatorId) => {
    restingAt = at;
    inFlight.current = false;
    if (settleTimer.current !== null) {
      window.clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
  };

  useEffect(() => {
    if (pillAt === active) {
      // Either born in place (nothing to animate) or the slide has been
      // committed and is under way — only the first is a rest.
      if (!inFlight.current) restingAt = active;
      return;
    }
    // One painted frame at the old position, then let the transition carry it.
    inFlight.current = true;
    const frame = requestAnimationFrame(() => {
      setPillAt(active);
      // `transitionend` records the rest; this is the fallback for when it never
      // fires (reduced motion, a hidden tab). Slightly after the travel so a
      // real `transitionend` wins. Held in a ref so the effect re-run that
      // `setPillAt` triggers cannot clear it — only unmount does, and an
      // unmount mid-flight is exactly the case where the rest must NOT be
      // recorded, so the next instance restarts the slide from the old side.
      settleTimer.current = window.setTimeout(() => arrive(active), TRAVEL_MS + 50);
    });
    return () => cancelAnimationFrame(frame);
  }, [active, pillAt]);

  useEffect(
    () => () => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    },
    [],
  );

  return (
    <div
      role="tablist"
      aria-label="KPI calculator views"
      className="relative flex flex-none items-center rounded-lg border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900/60"
    >
      <span
        aria-hidden
        onTransitionEnd={() => arrive(pillAt)}
        className={cn(
          'pointer-events-none absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-md',
          'bg-white shadow-sm dark:bg-zinc-800',
          'transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
          'motion-reduce:transition-none',
        )}
        style={{ transform: pillAt === 'hsl' ? 'translateX(100%)' : 'translateX(0)' }}
      />
      {TABS.map((t) => {
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.id)}
            className={cn(
              'relative z-10 min-w-[7.25rem] flex-1 basis-0 rounded-md px-2.5 py-1',
              'text-center text-xs font-medium outline-none transition-colors duration-200',
              'focus-visible:ring-2 focus-visible:ring-blue-500',
              isActive
                ? 'text-zinc-900 dark:text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100',
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
