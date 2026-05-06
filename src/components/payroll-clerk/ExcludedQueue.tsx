'use client';

import React, { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Banknote, Clock, DollarSign, Search, SearchX, ShieldOff, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { formatPHP, formatUSD, type ExcludedRow, type ExclusionReason } from './mock-queue';

interface ExcludedQueueProps {
  rows: ExcludedRow[];
}

const REASON_META: Record<
  ExclusionReason,
  {
    label: string;
    Icon: React.ComponentType<{ className?: string }>;
    /** Inactive (default) chip styling — soft tinted background. */
    tone: string;
    /** Active (selected as filter) chip styling — filled background. */
    activeTone: string;
  }
> = {
  no_bank: {
    label: 'No bank preferred',
    Icon: ShieldOff,
    tone: 'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300',
    activeTone: 'border-zinc-700 bg-zinc-800 text-white shadow-sm dark:border-zinc-200 dark:bg-zinc-100 dark:text-zinc-900',
  },
  no_pay: {
    label: 'No current pay',
    Icon: DollarSign,
    tone: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
    activeTone: 'border-amber-500 bg-amber-500 text-white shadow-sm shadow-amber-500/30 dark:border-amber-400 dark:bg-amber-500 dark:text-white',
  },
  no_hours: {
    label: 'No hours',
    Icon: Clock,
    tone: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300',
    activeTone: 'border-rose-500 bg-rose-500 text-white shadow-sm shadow-rose-500/30 dark:border-rose-400 dark:bg-rose-500 dark:text-white',
  },
};

function avatarColors(seed: string) {
  const palettes = [
    'from-zinc-400 to-zinc-600',
    'from-orange-400 to-rose-500',
    'from-violet-500 to-fuchsia-500',
    'from-sky-500 to-blue-600',
    'from-emerald-500 to-teal-500',
    'from-amber-500 to-orange-500',
  ];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return palettes[h % palettes.length];
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  if (parts[0]?.length >= 2) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0]?.[0] || '?').toUpperCase();
}

function ReasonChip({ reason }: { reason: ExclusionReason }) {
  const meta = REASON_META[reason];
  const Icon = meta.Icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]',
        meta.tone,
      )}
    >
      <Icon className="h-2.5 w-2.5" />
      {meta.label}
    </span>
  );
}

type ReasonFilter = 'all' | ExclusionReason;

export default function ExcludedQueue({ rows }: ExcludedQueueProps) {
  const [query, setQuery] = useState('');
  const [reasonFilter, setReasonFilter] = useState<ReasonFilter>('all');
  const debounced = useDebouncedValue(query, 250);

  // Aggregate counts per reason for the header summary chips.
  const counts = useMemo(() => {
    const c: Record<ExclusionReason, number> = { no_bank: 0, no_pay: 0, no_hours: 0 };
    for (const r of rows) for (const reason of r.reasons) c[reason] += 1;
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    const q = debounced.trim().toLowerCase();
    return rows.filter((r) => {
      if (reasonFilter !== 'all' && !r.reasons.includes(reasonFilter)) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.email.toLowerCase().includes(q) ||
        (r.bankPreferredRaw ?? '').toLowerCase().includes(q)
      );
    });
  }, [rows, debounced, reasonFilter]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-zinc-200/80 bg-gradient-to-r from-white via-zinc-50 to-white px-4 py-3 sm:px-6 sm:py-4 dark:border-zinc-800 dark:from-zinc-950 dark:via-zinc-950 dark:to-zinc-950">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight text-zinc-900 dark:text-white">
              <Banknote className="h-4 w-4 text-zinc-400" aria-hidden />
              No bank · No current pay · No hours
            </h2>
            <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
              Employees who can&apos;t be paid this cycle because at least one of the three signals is missing. Visible here so they don&apos;t silently disappear from the queue.
            </p>
          </div>
          <motion.span
            key={`exc-count-${filtered.length}`}
            initial={{ opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-full border border-zinc-200 bg-white/80 px-2.5 py-1 text-[11px] font-semibold text-zinc-700 backdrop-blur-md dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-300"
          >
            {filtered.length} {filtered.length === 1 ? 'person' : 'people'}
          </motion.span>
        </div>

        {/* Reason filter rail — single-select pills */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Filter by exclusion reason">
          <FilterPill
            label="All"
            count={rows.length}
            active={reasonFilter === 'all'}
            onClick={() => setReasonFilter('all')}
            tone="neutral"
          />
          {(['no_bank', 'no_pay', 'no_hours'] as const).map((r) => {
            const meta = REASON_META[r];
            return (
              <FilterPill
                key={r}
                label={meta.label}
                count={counts[r]}
                active={reasonFilter === r}
                onClick={() => setReasonFilter((prev) => (prev === r ? 'all' : r))}
                tone="reason"
                Icon={meta.Icon}
                activeClass={meta.activeTone}
                inactiveClass={meta.tone}
              />
            );
          })}
          {reasonFilter !== 'all' && (
            <button
              type="button"
              onClick={() => setReasonFilter('all')}
              className="ml-1 inline-flex h-7 items-center gap-1 rounded-full px-2 text-[10.5px] font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              aria-label="Clear reason filter"
            >
              <X className="h-3 w-3" />
              Clear
            </button>
          )}
        </div>

        {/* Search */}
        <div className="mt-3 flex items-center gap-2">
          <div className="relative max-w-sm flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <Input
              placeholder="Search name, email, bank"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 border-zinc-200 bg-white pl-8 pr-8 text-xs focus-visible:ring-zinc-200 dark:border-zinc-800 dark:bg-zinc-900"
              aria-label="Search excluded queue"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                aria-label="Clear search"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* List */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-gradient-to-b from-white via-zinc-50/30 to-white dark:from-[#0d1117] dark:via-[#0d1117] dark:to-[#0d1117]">
        {filtered.length === 0 ? (
          <EmptyState query={debounced} totalCount={rows.length} />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {filtered.map((row, i) => (
              <motion.li
                key={row.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18, delay: Math.min(i * 0.012, 0.2) }}
                className="bg-white/90 backdrop-blur-sm transition-colors hover:bg-zinc-50/80 dark:bg-zinc-950/90 dark:hover:bg-zinc-900/50"
              >
                <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
                  <div
                    className={cn(
                      'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-[11px] font-bold text-white shadow-sm',
                      avatarColors(row.id),
                    )}
                    aria-hidden
                  >
                    {initials(row.name)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                      {row.name}
                    </div>
                    <div className="truncate font-mono text-[11px] text-zinc-500">
                      {row.email}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {row.reasons.map((r) => (
                        <ReasonChip key={r} reason={r} />
                      ))}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div
                      className={cn(
                        'font-mono text-sm tabular-nums',
                        row.amountUSD == null ? 'text-zinc-300 dark:text-zinc-700' : 'text-zinc-700 dark:text-zinc-300',
                      )}
                    >
                      {formatUSD(row.amountUSD)}
                    </div>
                    <div
                      className={cn(
                        'font-mono text-[10.5px] tabular-nums',
                        row.amountPHP == null ? 'text-zinc-300 dark:text-zinc-700' : 'text-zinc-500 dark:text-zinc-500',
                      )}
                    >
                      {formatPHP(row.amountPHP)}
                    </div>
                    <div
                      className={cn(
                        'font-mono text-[10.5px] tabular-nums',
                        row.totalHours == null ? 'text-zinc-300 dark:text-zinc-700' : 'text-zinc-500 dark:text-zinc-500',
                      )}
                    >
                      {row.totalHours != null ? `${row.totalHours.toFixed(2)} hrs` : '— hrs'}
                    </div>
                  </div>
                </div>
              </motion.li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Clickable filter chip used in the Excluded queue header. Slightly bigger
 * than the per-row reason chips (h-7, text-[11px]) so they read as buttons,
 * not labels. The active state fills with the reason's accent color; the
 * inactive state shows the soft tinted variant.
 */
function FilterPill({
  label,
  count,
  active,
  onClick,
  tone,
  Icon,
  activeClass,
  inactiveClass,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  tone: 'neutral' | 'reason';
  Icon?: React.ComponentType<{ className?: string }>;
  activeClass?: string;
  inactiveClass?: string;
}) {
  const neutralActive =
    'border-zinc-900 bg-zinc-900 text-white shadow-sm dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900';
  const neutralInactive =
    'border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-300 dark:hover:border-zinc-600';

  const cls =
    tone === 'neutral'
      ? active
        ? neutralActive
        : neutralInactive
      : active
        ? activeClass!
        : `${inactiveClass!} hover:brightness-105 dark:hover:brightness-110`;

  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-semibold tracking-wide transition-all duration-150 active:scale-[0.97]',
        cls,
      )}
    >
      {Icon && <Icon className="h-3 w-3" />}
      <span>{label}</span>
      <span
        className={cn(
          'inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1 text-[10px] font-mono font-bold tabular-nums',
          active
            ? 'bg-white/20 text-current'
            : 'bg-black/5 text-current dark:bg-white/10',
        )}
      >
        {count}
      </span>
    </button>
  );
}

function EmptyState({ query, totalCount }: { query: string; totalCount: number }) {
  if (totalCount === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 py-16 text-center">
        <div>
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400 to-teal-500 text-white shadow-md shadow-emerald-500/30">
            <Banknote className="h-6 w-6" />
          </div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">Everyone is good</h3>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Every employee on the rates table has a bank, current pay, and hours for this cycle.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center px-6 py-16 text-center">
      <div>
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-zinc-200 to-zinc-300 text-zinc-600 shadow-sm dark:from-zinc-800 dark:to-zinc-700 dark:text-zinc-300">
          <SearchX className="h-6 w-6" />
        </div>
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">No matches</h3>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Nothing in the excluded list matches{' '}
          <span className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            {query}
          </span>
          .
        </p>
      </div>
    </div>
  );
}
