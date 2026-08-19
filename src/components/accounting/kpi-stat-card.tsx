import React from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * Shared gradient KPI card — the Payment Catalog → Summary band.
 *
 * Extracted from `PaymentCatalogOverview.tsx` (2026-08-19) so the People →
 * Bank changes band renders a byte-identical card set, exactly as
 * `hero-stat-row.tsx` was extracted for the CEO System Overview. Keep this the
 * single source of truth — do NOT fork it back into a dashboard. A second copy
 * is how two bands that are supposed to look the same start drifting.
 */

export type Tone = 'accent' | 'violet' | 'amber' | 'teal';

/** Soft two-stop gradients -- deliberately quiet (tint fades into the card
 *  surface) so the band reads instrumented, not flashy. */
export const TONES: Record<Tone, { card: string; chip: string }> = {
  accent: {
    card: 'border-orange-200/70 bg-gradient-to-br from-orange-100/90 via-amber-50/60 to-white dark:border-blue-900/50 dark:from-blue-950/60 dark:via-blue-950/20 dark:to-zinc-950',
    chip: 'bg-orange-500/15 text-orange-600 dark:bg-blue-500/15 dark:text-blue-300',
  },
  violet: {
    card: 'border-violet-200/70 bg-gradient-to-br from-violet-100/80 via-violet-50/40 to-white dark:border-violet-900/50 dark:from-violet-950/50 dark:via-violet-950/15 dark:to-zinc-950',
    chip: 'bg-violet-500/15 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300',
  },
  amber: {
    card: 'border-amber-200/70 bg-gradient-to-br from-amber-100/80 via-yellow-50/40 to-white dark:border-amber-900/50 dark:from-amber-950/40 dark:via-amber-950/10 dark:to-zinc-950',
    chip: 'bg-amber-500/15 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
  },
  teal: {
    card: 'border-teal-200/70 bg-gradient-to-br from-teal-100/80 via-cyan-50/40 to-white dark:border-teal-900/50 dark:from-teal-950/50 dark:via-teal-950/15 dark:to-zinc-950',
    chip: 'bg-teal-500/15 text-teal-600 dark:bg-teal-500/15 dark:text-teal-300',
  },
};

export function KpiLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10.5px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
      {children}
    </div>
  );
}

export function StatCard({
  tone,
  icon: Icon,
  label,
  headerExtra,
  children,
}: {
  tone: Tone;
  icon: LucideIcon;
  label: string;
  /** Optional element rendered in place of the icon chip (e.g. a button). */
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  const t = TONES[tone];
  return (
    <div className={`relative overflow-hidden rounded-2xl border p-4 shadow-sm ${t.card}`}>
      <div className="flex items-start justify-between gap-2">
        <KpiLabel>{label}</KpiLabel>
        {headerExtra ?? (
          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${t.chip}`}>
            <Icon className="h-4 w-4" />
          </span>
        )}
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

/** The big figure inside a stat card. */
export function StatValue({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[26px] font-semibold leading-8 tracking-tight tabular-nums text-zinc-900 dark:text-white">
      {children}
    </div>
  );
}

export function StatSub({ children }: { children: React.ReactNode }) {
  return <div className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">{children}</div>;
}
