'use client';

import { AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * "N of M ready" for the week, in the header — shared by both KPI calculators so
 * the two headers stay the same header.
 *
 * This is the Departments `DeadlineBanner` folded into a chip (Kane,
 * 2026-09-02: *"for the all departments submitted for this week put them at the
 * header"*). The banner was a full band under the bar carrying the same three
 * facts this carries — how many are submitted, of how many, and how long is
 * left — plus a repeat of the week range the title already prints. In the header
 * it sits first in the figure cluster, the same rounded-lg bordered shape as the
 * figure pill beside it, tinted by how urgent it is.
 *
 * `daysLeft` is optional because only the Departments calculator has a deadline
 * notion (managers submit before the week's payroll); HSL's week is pinned to the
 * Hubstaff batch and has no countdown. The chip is identical either way — the
 * countdown is one more span when it exists. Tiers are the banner's, unchanged:
 * done → emerald, ≥4 days → sky, ≤3 → amber, ≤1 or overdue → red.
 */
export function KpiReadinessChip({
  ready,
  total,
  daysLeft,
  overdue = false,
  noun = 'ready',
}: {
  ready: number;
  total: number;
  /** Days until the week's payroll; omit where there is no deadline (HSL). */
  daysLeft?: number;
  overdue?: boolean;
  /** What "ready" is called on this surface, for the tooltip. */
  noun?: string;
}) {
  const done = total > 0 && ready >= total;
  const hasDeadline = typeof daysLeft === 'number';
  const tier: 'done' | 'critical' | 'warn' | 'info' = done
    ? 'done'
    : hasDeadline && (overdue || daysLeft <= 1)
      ? 'critical'
      : hasDeadline && daysLeft <= 3
        ? 'warn'
        : 'info';

  const styles: Record<typeof tier, string> = {
    done: 'border-emerald-300/70 bg-emerald-50 text-emerald-800 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-200',
    info: 'border-zinc-200 bg-white text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-200',
    warn: 'border-amber-300/80 bg-amber-50 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200',
    critical: 'border-red-300/80 bg-red-50 text-red-900 dark:border-red-700/60 dark:bg-red-950/40 dark:text-red-200',
  };
  const Icon = done ? CheckCircle2 : tier === 'info' ? Clock : AlertTriangle;

  const countdown = !hasDeadline || done
    ? null
    : overdue
      ? 'window closing'
      : daysLeft <= 0
        ? 'due today'
        : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`;

  const title = done
    ? `All ${total} submitted for this week.`
    : `${total - ready} of ${total} not yet ${noun}${countdown ? ` · ${countdown}` : ''}.`;

  return (
    <div
      title={title}
      className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-1.5 shadow-sm',
        styles[tier],
      )}
    >
      <Icon
        className={cn('h-3.5 w-3.5 shrink-0', tier === 'critical' && 'animate-pulse motion-reduce:animate-none')}
        aria-hidden
      />
      <span className="font-mono text-sm font-bold tabular-nums">
        {ready}/{total}
      </span>
      <span className="font-mono text-[10px] uppercase tracking-[0.15em] opacity-80">
        {done ? 'all ready' : noun}
      </span>
      {countdown && (
        <span className="font-mono text-[10px] opacity-80">· {countdown}</span>
      )}
    </div>
  );
}
