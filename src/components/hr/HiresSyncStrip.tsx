'use client';

import { useState } from 'react';
import { AlertTriangle, ChevronDown, Database, Loader2, Lock, Plus, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import type { HeldHire, HoldReason } from '@/lib/hr/hires-source-map';

import type { HiresSourceSyncState } from './use-hires-source-sync';

/**
 * The New Hire Checklist's hiring-database strip (docs/features/new-hire-source-sync.md):
 * whether the live sync is running, "Sync now", and the HELD hires — the ones the
 * sync would not place on its own — each with an "Add to this week" button, which is
 * where the manual option and the polled data meet.
 */

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function formatWeek(startIso: string | null): string {
  if (!startIso) return '—';
  const [y, m, d] = startIso.split('-').map(Number);
  if (!y || !m || !d) return startIso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function holdLabel(h: HeldHire): string {
  const reason: HoldReason | null = h.hold_reason;
  if (reason === 'past_week') return `Week of ${formatWeek(h.target_period_start)} already passed`;
  if (reason === 'week_locked') return `Week of ${formatWeek(h.target_period_start)} is locked`;
  if (reason === 'no_interview_date') return 'No interview date';
  return 'Held';
}

export default function HiresSyncStrip({
  sync,
  periodLabel,
  locked,
  onPlace,
}: {
  sync: HiresSourceSyncState;
  /** The week the grid shows — where "Add to this week" places a held hire. */
  periodLabel: string;
  locked: boolean;
  onPlace: (hire: HeldHire) => void;
}) {
  const [open, setOpen] = useState(false);
  const { status, syncing, last, held, placing } = sync;

  const tone =
    status.kind === 'live' || status.kind === 'view_only'
      ? 'live'
      : status.kind === 'starting'
        ? 'idle'
        : status.kind === 'source_error' || status.kind === 'error'
          ? 'bad'
          : 'warn';

  let message: string;
  switch (status.kind) {
    case 'starting':
      message = 'Connecting to the hiring database…';
      break;
    case 'live':
      message = last
        ? `Live — checked ${formatClock(last.at)} · ${last.pulled.toLocaleString()} ${last.pulled === 1 ? 'hire' : 'hires'} in the hiring database`
        : 'Live';
      break;
    case 'view_only':
      message = 'Live — new hires arrive while an HR editor has this tab open';
      break;
    default:
      message = status.reason;
  }

  return (
    <div
      className={cn(
        'shrink-0 rounded-xl border px-3 py-2 text-[12px]',
        tone === 'live' && 'border-emerald-200 bg-white dark:border-emerald-900/60 dark:bg-zinc-900/50',
        tone === 'idle' && 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/50',
        tone === 'warn' && 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30',
        tone === 'bad' && 'border-rose-300 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/30',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex min-w-0 items-center gap-2">
          {tone === 'live' ? (
            <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
              <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 motion-safe:animate-ping" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
          ) : tone === 'idle' ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-zinc-400" />
          ) : (
            <AlertTriangle
              className={cn('h-3.5 w-3.5 shrink-0', tone === 'warn' ? 'text-amber-600' : 'text-rose-600')}
            />
          )}
          <Database className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span
            className={cn(
              'min-w-0 break-words',
              tone === 'live' || tone === 'idle'
                ? 'text-zinc-700 dark:text-zinc-300'
                : tone === 'warn'
                  ? 'text-amber-900 dark:text-amber-200'
                  : 'text-rose-800 dark:text-rose-200',
            )}
          >
            {message}
          </span>
        </span>

        {last && status.kind === 'live' && last.placed + last.linked + last.updatedCells > 0 && (
          <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
            Last sync: {last.placed} added
            {last.linked > 0 ? ` · ${last.linked} matched` : ''}
            {last.updatedCells > 0 ? ` · ${last.updatedCells} cells updated` : ''}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {held.length > 0 && (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className="flex h-7 items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-2 text-[11px] font-semibold text-amber-800 transition hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200 dark:hover:bg-amber-950/50"
            >
              Not placed ({held.length})
              <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
            </button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={sync.syncNow}
            disabled={syncing}
            className="h-7 gap-1.5 border-emerald-200 px-2 text-[11px] text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300"
          >
            <RefreshCw className={cn('h-3 w-3', syncing && 'animate-spin')} />
            Sync now
          </Button>
        </div>
      </div>

      {last && status.kind === 'live' && (last.truncated || last.skippedNoId > 0 || last.errors.length > 0) && (
        <ul className="mt-1.5 space-y-0.5 text-[11px]">
          {last.truncated && (
            <li className="font-semibold text-rose-700 dark:text-rose-300">
              The hiring database has more than 20,000 rows — only the first 20,000 were read.
            </li>
          )}
          {last.skippedNoId > 0 && (
            <li className="text-amber-800 dark:text-amber-300">
              {last.skippedNoId} {last.skippedNoId === 1 ? 'row has' : 'rows have'} no id in the hiring database and
              {last.skippedNoId === 1 ? ' was' : ' were'} skipped.
            </li>
          )}
          {last.errors.length > 0 && (
            <li className="text-amber-800 dark:text-amber-300">
              {last.errors.length} {last.errors.length === 1 ? 'hire' : 'hires'} could not be written: {last.errors[0]}
            </li>
          )}
        </ul>
      )}

      {open && held.length > 0 && (
        <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-amber-200 bg-white dark:border-amber-900/50 dark:bg-zinc-950">
          <p className="border-b border-amber-100 px-2.5 py-1.5 text-[11px] text-zinc-600 dark:border-amber-900/40 dark:text-zinc-400">
            From the hiring database, not placed automatically. The sync never fills a past week or a locked
            week by itself. Add one to <strong>{periodLabel}</strong> if it belongs there.
          </p>
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="text-left text-[10.5px] uppercase tracking-wide text-zinc-500">
                <th className="px-2.5 py-1.5 font-semibold">Name</th>
                <th className="px-2.5 py-1.5 font-semibold">Personal email</th>
                <th className="px-2.5 py-1.5 font-semibold">Department</th>
                <th className="px-2.5 py-1.5 font-semibold">Interview</th>
                <th className="px-2.5 py-1.5 font-semibold">Why not placed</th>
                <th className="px-2.5 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {held.map((h) => (
                <tr key={h.source_key} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="whitespace-nowrap px-2.5 py-1.5 text-zinc-800 dark:text-zinc-100">{h.name || '—'}</td>
                  <td className="whitespace-nowrap px-2.5 py-1.5 text-zinc-600 dark:text-zinc-300">
                    {h.personal_email || '—'}
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-1.5 text-zinc-600 dark:text-zinc-300">
                    {formatDeptLabel(h.department ?? '') || '—'}
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-1.5 tabular-nums text-zinc-600 dark:text-zinc-300">
                    {h.date_of_interview || '—'}
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-1.5 text-amber-800 dark:text-amber-300">{holdLabel(h)}</td>
                  <td className="whitespace-nowrap px-2.5 py-1.5 text-right">
                    <span title={locked ? `${periodLabel} is locked — reopen it to add a hire` : undefined}>
                      <button
                        type="button"
                        onClick={() => onPlace(h)}
                        disabled={locked || placing !== null}
                        aria-label={`Add ${h.name || 'this hire'} to ${periodLabel}`}
                        className="inline-flex h-7 items-center gap-1 rounded-lg border border-emerald-300 bg-emerald-50 px-2 text-[11px] font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"
                      >
                        {placing === h.source_key ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : locked ? (
                          <Lock className="h-3 w-3" />
                        ) : (
                          <Plus className="h-3 w-3" />
                        )}
                        Add to this week
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
