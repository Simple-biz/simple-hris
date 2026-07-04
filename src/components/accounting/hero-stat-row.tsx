import React from 'react';
import { cn } from '@/lib/utils';

/**
 * Shared hero stat-row + tone palette for the "System Overview" metric rail.
 *
 * Extracted from the Accounting dashboard (`Overview.tsx`) so the CEO overview
 * can render a byte-identical System Overview board. The Accounting AttentionCard
 * also consumes ATTENTION_PALETTE. Keep this the single source of truth — do not
 * fork it back into the dashboards.
 */
export type AttentionTone = 'warn' | 'info' | 'ok' | 'neutral';

export const ATTENTION_PALETTE: Record<AttentionTone, {
  ring: string;
  surface: string;
  iconTile: string;
  label: string;
  valueText: string;
  tag: string;
  cta: string;
  hoverShadow: string;
  blob: string;
}> = {
  warn: {
    ring: 'border-amber-200/70 hover:border-amber-300/90 dark:border-amber-900/40 dark:hover:border-amber-700/50',
    surface:
      'bg-gradient-to-br from-amber-50/85 via-orange-50/35 to-stone-50 dark:from-amber-950/40 dark:via-orange-950/20 dark:to-zinc-950',
    iconTile: 'bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-md shadow-amber-500/40',
    label: 'text-amber-800/90 dark:text-amber-300',
    valueText: 'text-amber-900 dark:text-amber-100',
    tag: 'bg-stone-50/80 text-amber-800 ring-1 ring-amber-200/70 dark:bg-zinc-900/70 dark:text-amber-300 dark:ring-amber-900/40',
    cta: 'text-amber-800 dark:text-amber-300',
    hoverShadow: 'group-hover:shadow-[0_12px_32px_-12px_rgba(245,158,11,0.35)]',
    blob: 'bg-amber-300/30 dark:bg-amber-500/15',
  },
  info: {
    ring: 'border-sky-200/70 hover:border-sky-300/90 dark:border-sky-900/40 dark:hover:border-sky-700/50',
    surface:
      'bg-gradient-to-br from-sky-50/85 via-blue-50/35 to-stone-50 dark:from-sky-950/40 dark:via-blue-950/20 dark:to-zinc-950',
    iconTile: 'bg-gradient-to-br from-sky-500 to-blue-600 text-white shadow-md shadow-blue-500/40',
    label: 'text-sky-800/90 dark:text-sky-300',
    valueText: 'text-sky-900 dark:text-sky-100',
    tag: 'bg-stone-50/80 text-sky-800 ring-1 ring-sky-200/70 dark:bg-zinc-900/70 dark:text-sky-300 dark:ring-sky-900/40',
    cta: 'text-sky-800 dark:text-sky-300',
    hoverShadow: 'group-hover:shadow-[0_12px_32px_-12px_rgba(59,130,246,0.35)]',
    blob: 'bg-sky-300/30 dark:bg-sky-500/15',
  },
  ok: {
    ring: 'border-emerald-200/70 hover:border-emerald-300/90 dark:border-emerald-900/40 dark:hover:border-emerald-700/50',
    surface:
      'bg-gradient-to-br from-emerald-50/85 via-teal-50/35 to-stone-50 dark:from-emerald-950/40 dark:via-teal-950/20 dark:to-zinc-950',
    iconTile: 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-md shadow-emerald-500/40',
    label: 'text-emerald-800/90 dark:text-emerald-300',
    valueText: 'text-emerald-900 dark:text-emerald-100',
    tag: 'bg-stone-50/80 text-emerald-800 ring-1 ring-emerald-200/70 dark:bg-zinc-900/70 dark:text-emerald-300 dark:ring-emerald-900/40',
    cta: 'text-emerald-800 dark:text-emerald-300',
    hoverShadow: 'group-hover:shadow-[0_12px_32px_-12px_rgba(16,185,129,0.35)]',
    blob: 'bg-emerald-300/30 dark:bg-emerald-500/15',
  },
  neutral: {
    ring: 'border-zinc-200/80 hover:border-zinc-300 dark:border-zinc-800/80 dark:hover:border-zinc-700',
    surface: 'bg-gradient-to-br from-stone-50 to-stone-100/60 dark:from-zinc-900/60 dark:to-zinc-950',
    iconTile: 'bg-gradient-to-br from-zinc-700 to-zinc-900 text-white shadow-md shadow-zinc-900/30 dark:from-zinc-100 dark:to-zinc-300 dark:text-zinc-900',
    label: 'text-zinc-600 dark:text-zinc-400',
    valueText: 'text-zinc-900 dark:text-zinc-100',
    tag: 'bg-zinc-100 text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:ring-zinc-700',
    cta: 'text-zinc-900 dark:text-zinc-100',
    hoverShadow: 'group-hover:shadow-[0_12px_32px_-12px_rgba(0,0,0,0.18)]',
    blob: 'bg-zinc-200/30 dark:bg-zinc-700/20',
  },
};

export function HeroStatRow({
  Icon,
  tone,
  label,
  value,
  tooltip,
  action,
  onClick,
}: {
  Icon: React.ComponentType<{ className?: string }>;
  tone: AttentionTone;
  label: string;
  value: number | null;
  /** Optional rich hover explainer. When set, the row gains a "?"-style affordance
   *  and reveals this content (hover or keyboard focus) in a floating card. */
  tooltip?: React.ReactNode;
  /** Optional trailing control (e.g. an export button) rendered after the value. */
  action?: React.ReactNode;
  /** When set, the whole row becomes a button that opens a drill-down (e.g. the
   *  Hubstaff ↔ Master reconciliation modal). Keyboard-activatable; the hover
   *  tooltip (if any) still works. */
  onClick?: () => void;
}) {
  const palette = ATTENTION_PALETTE[tone];
  const interactive = tooltip != null || onClick != null;
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-xl border bg-stone-50/70 px-3 py-2 backdrop-blur-md transition-colors',
        palette.ring,
        'dark:bg-zinc-900/60',
        interactive && 'group relative focus:outline-none',
        onClick ? 'cursor-pointer' : tooltip ? 'cursor-help' : undefined,
      )}
      tabIndex={interactive ? 0 : undefined}
      role={onClick ? 'button' : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <span
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg [&_svg]:h-3.5 [&_svg]:w-3.5',
          palette.iconTile,
        )}
      >
        <Icon />
      </span>
      <span className="flex-1 truncate text-[11.5px] text-zinc-600 dark:text-zinc-400">
        {label}
      </span>
      <span
        className={cn(
          'font-mono text-sm font-semibold tabular-nums',
          palette.valueText,
        )}
      >
        {value == null ? '—' : value.toLocaleString('en-US')}
      </span>
      {action}
      {tooltip && (
        <div
          role="tooltip"
          className="pointer-events-none absolute bottom-full right-0 z-30 mb-2 w-[280px] origin-bottom-right scale-95 rounded-xl border border-zinc-200 bg-white p-3 text-left text-zinc-700 opacity-0 shadow-xl shadow-zinc-900/10 transition-all duration-150 group-hover:scale-100 group-hover:opacity-100 group-focus:scale-100 group-focus:opacity-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:shadow-black/40"
        >
          {tooltip}
        </div>
      )}
    </div>
  );
}
