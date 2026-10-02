'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { CircleCheck, LoaderCircle, Lock, LockOpen, TriangleAlert } from 'lucide-react';

import { cn } from '@/lib/utils';
import { NPD_UNLOCK_REASON_MAX } from '@/lib/npd/sheet';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { LockResult } from './useNpdSheet';

/**
 * Lock in / Unlock, as a modal with its timestamps (Kane, 2026-10-02: "Smoothen the
 * lockin animation please and add a modal that has a time stamp on it please").
 * Governing doc: docs/features/npd-dashboard.md § Lock in.
 *
 * Nothing about the rules moved: Lock in still saves pending edits first and locks
 * exactly the version on screen (useNpdSheet.lock); Unlock still needs a written
 * reason, which the route records BEFORE it unlocks. This is the house Dialog, never
 * `window.confirm`.
 *
 *  - Lock in: a live clock ("Locks at …") while it asks, then the SERVER's lock time
 *    and who locked it once it is done. The lock closes once, as the one moment.
 *  - Unlock: when it was locked and by whom, a required reason, then the time it was
 *    unlocked (this device's clock, said so).
 * While it works it cannot be dismissed, so a half-finished lock is never hidden.
 */

const EASE = [0.22, 1, 0.36, 1] as const;

/** "Oct 2, 2026, 3:14:05 PM EDT": the reader's clock, with its zone named. */
export function formatLockStamp(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return String(d);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });
}

type Phase = 'ask' | 'working' | 'done';

export default function NpdLockDialog({
  mode,
  open,
  onOpenChange,
  sheetLabel,
  weekText,
  rowCount,
  rateText,
  lockedAt,
  lockedBy,
  onLock,
  onUnlock,
}: {
  mode: 'lock' | 'unlock';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetLabel: string;
  weekText: string;
  rowCount: number;
  rateText: string;
  /** The sheet's lock, from the server (null while unlocked). */
  lockedAt: string | null;
  lockedBy: string | null;
  onLock: () => Promise<LockResult>;
  onUnlock: (reason: string) => Promise<LockResult>;
}) {
  const reduce = useReducedMotion() ?? false;
  const [phase, setPhase] = useState<Phase>('ask');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [now, setNow] = useState(() => new Date());
  const [unlockedAt, setUnlockedAt] = useState<Date | null>(null);

  // A fresh start each time it opens.
  useEffect(() => {
    if (!open) return;
    setPhase('ask');
    setError(null);
    setNote(null);
    setReason('');
    setUnlockedAt(null);
    setNow(new Date());
  }, [open, mode]);

  // The live clock, only while it is asking.
  useEffect(() => {
    if (!open || phase !== 'ask') return;
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, [open, phase]);

  const working = phase === 'working';
  const done = phase === 'done';
  const trimmed = reason.trim();

  const confirm = async () => {
    if (working) return;
    if (mode === 'unlock' && !trimmed) return;
    setError(null);
    setPhase('working');
    const r = mode === 'lock' ? await onLock() : await onUnlock(trimmed);
    if (r.ok) {
      setNote(r.message ?? null);
      if (mode === 'unlock') setUnlockedAt(new Date());
      setPhase('done');
    } else {
      setError(r.message ?? 'That did not work. Nothing was changed.');
      setPhase('ask');
    }
  };

  const closedIcon = mode === 'lock' ? done : !done;
  const title = done ? (mode === 'lock' ? 'Locked in' : 'Unlocked') : mode === 'lock' ? `Lock in ${sheetLabel}?` : `Unlock ${sheetLabel}?`;
  const btn =
    'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <Dialog open={open} onOpenChange={(o) => !working && onOpenChange(o)}>
      <DialogContent
        showCloseButton={!working}
        className="flex max-h-[calc(100dvh-1.5rem)] flex-col gap-0 overflow-y-auto p-0 sm:max-w-md"
      >
        <div className="flex items-start gap-3 px-5 pb-3 pt-5">
          {/* The one authored moment: the lock closes (or opens) when it is done. */}
          <div
            className={cn(
              'relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ring-1 transition-colors duration-300',
              closedIcon
                ? 'bg-indigo-100 text-indigo-700 ring-indigo-200 dark:bg-indigo-950/60 dark:text-indigo-300 dark:ring-indigo-900'
                : 'bg-zinc-100 text-zinc-600 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-800',
            )}
            aria-hidden
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={closedIcon ? 'closed' : 'open'}
                initial={reduce ? false : { opacity: 0, scale: 0.6, rotate: closedIcon ? -14 : 14, y: closedIcon ? -3 : 3 }}
                animate={{ opacity: 1, scale: 1, rotate: 0, y: 0 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.7 }}
                transition={{ duration: reduce ? 0 : 0.38, ease: EASE }}
                className="absolute"
              >
                {closedIcon ? <Lock className="h-5 w-5" /> : <LockOpen className="h-5 w-5" />}
              </motion.span>
            </AnimatePresence>
            {done && !reduce && (
              <motion.span
                className="absolute inset-0 rounded-xl ring-2 ring-indigo-400/60"
                initial={{ opacity: 0.9, scale: 1 }}
                animate={{ opacity: 0, scale: 1.35 }}
                transition={{ duration: 0.7, ease: EASE }}
              />
            )}
          </div>
          <div className="min-w-0 pr-6">
            <DialogTitle className="text-base font-semibold text-zinc-900 dark:text-zinc-50">{title}</DialogTitle>
            <DialogDescription className="mt-0.5 text-[13px] text-zinc-600 dark:text-zinc-400">
              {done ? `${sheetLabel} · ${weekText}` : weekText}
            </DialogDescription>
          </div>
        </div>

        <div className="flex flex-col gap-3 px-5 pb-4">
          {/* The timestamp block. */}
          <div className="rounded-lg border border-zinc-200 bg-white/80 px-3.5 py-3 dark:border-zinc-800 dark:bg-zinc-950/60" data-testid="npd-lock-stamp">
            {mode === 'lock' && !done && (
              <>
                <p className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">Locks at</p>
                <p className="mt-0.5 font-mono text-sm tabular-nums text-zinc-900 dark:text-zinc-100" aria-live="off">
                  {formatLockStamp(now)}
                </p>
                <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">The server stamps the exact moment you press Lock in.</p>
              </>
            )}
            {mode === 'lock' && done && (
              <>
                <p className="text-[11px] font-medium text-indigo-700 dark:text-indigo-300">Locked in at</p>
                <p className="mt-0.5 font-mono text-sm tabular-nums text-zinc-900 dark:text-zinc-100">
                  {lockedAt ? formatLockStamp(lockedAt) : 'just now'}
                </p>
                {lockedBy && <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">by {lockedBy}</p>}
              </>
            )}
            {mode === 'unlock' && !done && (
              <>
                <p className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">Locked in at</p>
                <p className="mt-0.5 font-mono text-sm tabular-nums text-zinc-900 dark:text-zinc-100">
                  {lockedAt ? formatLockStamp(lockedAt) : 'unknown'}
                </p>
                {lockedBy && <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">by {lockedBy}</p>}
              </>
            )}
            {mode === 'unlock' && done && (
              <>
                <p className="text-[11px] font-medium text-emerald-700 dark:text-emerald-300">Unlocked at</p>
                <p className="mt-0.5 font-mono text-sm tabular-nums text-zinc-900 dark:text-zinc-100">
                  {formatLockStamp(unlockedAt ?? new Date())}
                </p>
                <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">This device’s clock. The reason is on the record.</p>
              </>
            )}
          </div>

          {!done && mode === 'lock' && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
              <dt className="text-zinc-500 dark:text-zinc-400">Rows</dt>
              <dd className="tabular-nums text-zinc-900 dark:text-zinc-100">{rowCount}</dd>
              <dt className="text-zinc-500 dark:text-zinc-400">PHP→USD rate</dt>
              <dd className="font-mono tabular-nums text-zinc-900 dark:text-zinc-100">{rateText || 'none'}</dd>
            </dl>
          )}
          {!done && mode === 'lock' && (
            <p className="text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-300">
              Your unsaved edits are saved first. Then nobody can change any value on this sheet until it is unlocked, and
              unlocking needs a written reason.
            </p>
          )}

          {!done && mode === 'unlock' && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="npd-unlock-reason" className="text-[13px] font-medium text-zinc-800 dark:text-zinc-200">
                Why unlock it? <span className="font-normal text-zinc-500 dark:text-zinc-400">(required, recorded before it unlocks)</span>
              </label>
              <textarea
                id="npd-unlock-reason"
                autoFocus
                rows={3}
                value={reason}
                maxLength={NPD_UNLOCK_REASON_MAX}
                disabled={working}
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void confirm();
                  }
                }}
                className="w-full resize-none rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/30 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              />
              <p className="self-end text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
                {reason.length} / {NPD_UNLOCK_REASON_MAX}
              </p>
            </div>
          )}

          {done && note && <p className="text-[13px] text-zinc-600 dark:text-zinc-400">{note}</p>}

          {error && (
            <p role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {error}
            </p>
          )}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-zinc-200/80 bg-white/50 px-5 py-3 sm:flex-row sm:justify-end dark:border-zinc-800 dark:bg-zinc-950/30">
          {done ? (
            <button type="button" autoFocus onClick={() => onOpenChange(false)} className={cn(btn, 'bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white')}>
              <CircleCheck className="h-4 w-4" /> Done
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={working}
                onClick={() => onOpenChange(false)}
                className={cn(btn, 'border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900')}
              >
                Cancel
              </button>
              <button
                type="button"
                autoFocus={mode === 'lock'}
                disabled={working || (mode === 'unlock' && !trimmed)}
                onClick={() => void confirm()}
                className={cn(btn, 'bg-indigo-600 text-white enabled:hover:bg-indigo-700')}
              >
                {working ? (
                  <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                ) : mode === 'lock' ? (
                  <Lock className="h-4 w-4" />
                ) : (
                  <LockOpen className="h-4 w-4" />
                )}
                {working ? (mode === 'lock' ? 'Locking in…' : 'Unlocking…') : mode === 'lock' ? 'Lock in' : 'Unlock'}
              </button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
