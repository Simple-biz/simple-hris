'use client';

/**
 * "N payees are at Threshold" — the notice Payment Dispatch pops once the live
 * week has loaded and the under-US$15 rule has run (Kane, 2026-09-29).
 *
 * The headline is the progress strip's own held count (`heldCount` in
 * PayrollDispatch), never a second tally, so the notice and the strip can't
 * disagree. The list is every Threshold hold this week — the rule's and a
 * clerk's alike — each marked with who made it.
 *
 * Height-capped with one scrolling body (see memory dialog-content-no-height-cap):
 * a week with 40 holds must never push the buttons off-screen.
 */

import { AlertTriangle } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { AUTO_THRESHOLD_LIMIT_USD } from '@/lib/payroll/auto-threshold';
import { formatPHP, formatUSD } from './mock-queue';

export interface ThresholdNoticePerson {
  email: string;
  name: string | null;
  amountUSD: number | null;
  amountPHP: number | null;
  processorLabel: string;
  /** Held by the rule (vs logged by a clerk from Mark Paid). */
  auto: boolean;
}

export default function AutoThresholdNotice({
  open,
  heldCount,
  flaggedNowCount,
  people,
  warning,
  onReview,
  onClose,
}: {
  open: boolean;
  heldCount: number;
  flaggedNowCount: number;
  people: readonly ThresholdNoticePerson[];
  warning: string | null;
  onReview: () => void;
  onClose: () => void;
}) {
  const limit = formatUSD(AUTO_THRESHOLD_LIMIT_USD);
  const headline = `${heldCount} ${heldCount === 1 ? 'payee is' : 'payees are'} at Threshold`;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="flex max-h-[calc(100dvh-1.5rem)] flex-col gap-0 overflow-hidden p-0 sm:max-h-[92dvh] sm:max-w-md">
        <div className="flex shrink-0 items-start gap-3 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
            <AlertTriangle className="h-4.5 w-4.5" aria-hidden />
          </span>
          <div className="min-w-0 space-y-1">
            <DialogTitle className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{headline}</DialogTitle>
            <DialogDescription className="text-sm text-zinc-600 dark:text-zinc-400">
              Anything under {limit} is held this week, not sent.
              {flaggedNowCount > 0
                ? ` ${flaggedNowCount} ${flaggedNowCount === 1 ? 'was' : 'were'} flagged automatically just now.`
                : ''}
            </DialogDescription>
          </div>
        </div>

        <ul className="min-h-0 flex-1 divide-y divide-zinc-100 overflow-y-auto px-5 dark:divide-zinc-800/80">
          {people.map((p) => (
            <li key={p.email} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{p.name || p.email}</p>
                <p className="truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{p.email}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{formatUSD(p.amountUSD)}</p>
                <p className="text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
                  {formatPHP(p.amountPHP)} · {p.processorLabel}
                </p>
              </div>
              <span
                className={
                  p.auto
                    ? 'shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300'
                    : 'shrink-0 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[10px] font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
                }
                title={p.auto ? `Held by the under-${limit} rule` : 'Logged Threshold by a clerk from Mark Paid'}
              >
                {p.auto ? 'Auto' : 'Manual'}
              </span>
            </li>
          ))}
        </ul>

        <div className="shrink-0 space-y-3 border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
          {warning ? <p className="text-xs text-rose-700 dark:text-rose-300">{warning}</p> : null}
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            To pay someone anyway, clear them from the Threshold tab. The rule won&apos;t hold them again this week.
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              Done
            </button>
            <button
              type="button"
              onClick={onReview}
              className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-700 dark:bg-amber-500 dark:text-amber-950 dark:hover:bg-amber-400"
            >
              Review Threshold tab
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
