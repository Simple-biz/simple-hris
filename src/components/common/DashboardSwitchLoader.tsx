'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  LayoutDashboard,
  ShieldCheck,
  Briefcase,
  UserCog,
  HeartHandshake,
  Crown,
  Users,
  HardHat,
  ClipboardCheck,
  SquareKanban,
} from 'lucide-react';
import { VIEW_LABELS, type AppView } from '@/lib/rbac/views';
import { cn } from '@/lib/utils';

/**
 * Route-level loading state for a dashboard switch. Rendered from each dashboard's
 * `loading.tsx` (and the /accounting Suspense fallback), so the moment a switch
 * begins the user sees a shaped skeleton of the shell PLUS a floating
 * "Switching to <X> Dashboard" card — no bare spinner. Styled after the Payment
 * Dispatch loader (skeleton behind, card floating above).
 *
 * Client component (motion + timers) rendered inside the server `loading.tsx`
 * boundary — Next SSRs the first frame, then it hydrates and animates. It knows
 * its own dashboard from the `view` prop the route passes, since the switcher's
 * in-flight state lives on the outgoing page and is gone by the time this mounts.
 */

const VIEW_ICONS: Record<AppView, React.ComponentType<{ className?: string }>> = {
  employee: LayoutDashboard,
  admin: ShieldCheck,
  accounting: Briefcase,
  manager: UserCog,
  orphanage: HeartHandshake,
  ceo: Crown,
  hr: Users,
  contractor: HardHat,
  qc: ClipboardCheck,
  tickets: SquareKanban,
};

const STATUS_MESSAGES = [
  'Loading your workspace',
  'Fetching the latest data',
  'Checking your permissions',
  'Almost ready',
];

// Deterministic sidebar row widths so SSR and the hydrated client render match.
const NAV_ROWS = [88, 72, 96, 64, 80, 92, 68];

const CYCLE_MS = 1400;
const TICK_MS = 120;
// Perceived pace — the card unmounts the instant the real dashboard is ready, so
// this only sets how fast the bar creeps while we wait; a switch is usually quick.
const EXPECTED_MS = 6000;

export default function DashboardSwitchLoader({
  view,
  label: labelProp,
}: {
  /** Maps to the label + icon. Omit for routes outside the switcher's AppView
   *  set (e.g. payroll-clerk) and pass `label` instead. */
  view?: AppView;
  label?: string;
}) {
  const label = labelProp ?? (view ? VIEW_LABELS[view] : 'Dashboard');
  const Icon = view ? VIEW_ICONS[view] : LayoutDashboard;
  const isTickets = view === 'tickets';

  const [index, setIndex] = useState(0);
  const [percent, setPercent] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setIndex((i) => (i + 1) % STATUS_MESSAGES.length), CYCLE_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let elapsed = 0;
    const id = setInterval(() => {
      elapsed += TICK_MS;
      setPercent(Math.min(99, (elapsed / EXPECTED_MS) * 99));
    }, TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Tone: default orange (light/dark aware); tickets is fixed red-on-black.
  const tone = isTickets
    ? {
        root: 'bg-black',
        card: 'border-red-900/60 bg-zinc-950/90 shadow-[0_8px_48px_-12px_rgba(220,38,38,0.35)]',
        ring: 'border-red-500/50',
        emblem: 'from-red-600 to-red-500 shadow-red-900/50',
        title: 'text-zinc-50',
        eyebrow: 'text-red-500',
        status: 'text-red-400',
        dot: 'bg-red-500',
        barTrack: 'bg-red-950/50',
        barFill: 'from-red-500 to-red-400',
        scrim: 'bg-black/40',
      }
    : {
        root: 'bg-white dark:bg-[#0d1117]',
        card: 'border-orange-100/80 bg-white/90 shadow-[0_8px_48px_-12px_rgba(234,88,12,0.28)] dark:border-zinc-800 dark:bg-zinc-950/85 dark:shadow-[0_8px_48px_-12px_rgba(0,0,0,0.6)]',
        ring: 'border-orange-300/60 dark:border-orange-500/40',
        emblem: 'from-orange-500 to-amber-500 shadow-orange-500/40',
        title: 'text-zinc-900 dark:text-zinc-50',
        eyebrow: 'text-orange-500 dark:text-orange-400',
        status: 'text-orange-600 dark:text-orange-400',
        dot: 'bg-orange-500 dark:bg-orange-400',
        barTrack: 'bg-orange-100/70 dark:bg-zinc-800',
        barFill: 'from-orange-400 to-amber-500',
        scrim: 'bg-white/30 dark:bg-[#0d1117]/40',
      };

  return (
    <div
      className={cn('relative h-dvh max-h-dvh w-full overflow-hidden', tone.root)}
      aria-busy="true"
      aria-label={`Switching to ${label} dashboard`}
    >
      {/* ── Skeleton layer — the dashboard shell shape behind the card ── */}
      <div className="absolute inset-0 flex">
        {/* Sidebar rail (desktop) */}
        <aside className="hidden w-60 shrink-0 flex-col gap-2 border-r border-zinc-100/80 p-4 md:flex dark:border-zinc-800/70">
          <div className="skeleton-shimmer mb-4 h-8 w-32 rounded-md" />
          {NAV_ROWS.map((w, i) => (
            <div
              key={i}
              className="skeleton-shimmer h-8 rounded-md"
              style={{ width: `${w}%` }}
            />
          ))}
        </aside>

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-14 shrink-0 items-center gap-3 border-b border-zinc-100/80 px-4 dark:border-zinc-800/70">
            <div className="skeleton-shimmer h-6 w-40 rounded-md" />
            <div className="skeleton-shimmer ml-auto h-8 w-8 rounded-full" />
          </div>
          <div className="flex-1 space-y-4 overflow-hidden p-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="skeleton-shimmer h-24 rounded-xl" />
              ))}
            </div>
            <div className="skeleton-shimmer h-72 rounded-xl" />
          </div>
        </div>
      </div>

      {/* Subtle scrim so the card reads clearly over the shimmer. */}
      <div className={cn('absolute inset-0 backdrop-blur-[2px]', tone.scrim)} />

      {/* ── Floating "Switching to …" card ── */}
      <div className="absolute inset-0 flex items-center justify-center px-6">
        <motion.div
          initial={{ opacity: 0, y: 14, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className={cn(
            'w-full max-w-sm rounded-2xl border p-8 backdrop-blur-xl',
            tone.card,
          )}
        >
          {/* Pulsing dashboard emblem with concentric rings */}
          <div className="relative mx-auto flex h-16 w-16 items-center justify-center">
            {[0, 1].map((r) => (
              <motion.span
                key={r}
                className={cn('absolute inset-0 rounded-2xl border', tone.ring)}
                initial={{ scale: 0.7, opacity: 0.7 }}
                animate={{ scale: 1.9, opacity: 0 }}
                transition={{ duration: 1.9, repeat: Infinity, ease: 'easeOut', delay: r * 0.95 }}
              />
            ))}
            <motion.div
              className={cn(
                'relative flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br text-white shadow-lg',
                tone.emblem,
              )}
              animate={{ scale: [1, 1.06, 1] }}
              transition={{ duration: 1.9, repeat: Infinity, ease: 'easeInOut' }}
            >
              <Icon className="h-7 w-7" />
            </motion.div>
          </div>

          <div className="mt-5 text-center">
            <div
              className={cn(
                'text-[11px] font-semibold uppercase tracking-[0.18em]',
                tone.eyebrow,
              )}
            >
              Switching to
            </div>
            <h2 className={cn('mt-1 text-xl font-bold', tone.title)}>{label} Dashboard</h2>
          </div>

          {/* Cycling status line */}
          <div className="relative mt-3 flex h-6 items-center justify-center overflow-hidden">
            <AnimatePresence mode="wait">
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className={cn('flex items-center gap-2 text-sm font-medium', tone.status)}
              >
                <span className="inline-flex gap-0.5">
                  {[0, 1, 2].map((d) => (
                    <motion.span
                      key={d}
                      className={cn('h-1 w-1 rounded-full', tone.dot)}
                      animate={{ opacity: [0.3, 1, 0.3] }}
                      transition={{ duration: 0.9, repeat: Infinity, ease: 'easeInOut', delay: d * 0.15 }}
                    />
                  ))}
                </span>
                {STATUS_MESSAGES[index]}
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Determinate-feel progress bar with sweeping shimmer */}
          <div className="mt-6">
            <div className={cn('h-1.5 w-full overflow-hidden rounded-full', tone.barTrack)}>
              <motion.div
                className={cn('relative h-full rounded-full bg-gradient-to-r', tone.barFill)}
                animate={{ width: `${percent}%` }}
                transition={{ duration: TICK_MS / 1000, ease: 'linear' }}
              >
                <motion.span
                  className="absolute inset-0 bg-gradient-to-r from-transparent via-white/50 to-transparent"
                  animate={{ x: ['-100%', '180%'] }}
                  transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
                />
              </motion.div>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
