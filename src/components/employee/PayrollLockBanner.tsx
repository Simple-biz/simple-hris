'use client';

import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Lock, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PayrollDispatchLockState } from '@/lib/supabase/payroll-dispatch-lock';

interface PayrollLockBannerProps {
  state: PayrollDispatchLockState;
}

function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const start = new Date(iso).getTime();
  if (!Number.isFinite(start)) return null;
  const diffSec = Math.max(0, Math.floor((Date.now() - start) / 1000));
  if (diffSec < 60) return 'just now';
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min} min${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr${hr === 1 ? '' : 's'} ago`;
  const days = Math.floor(hr / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function startedByLabel(email: string | null): string | null {
  if (!email) return null;
  const local = email.split('@')[0] ?? '';
  if (!local) return null;
  const cleaned = local.replace(/[._-]+/g, ' ').trim();
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Global "payroll being processed" banner mounted at the top of the employee
 * shell. Animates in when the lock flips on, animates out when it flips off.
 * Doesn't render at all in the normal case so it's invisible until needed.
 */
export default function PayrollLockBanner({ state }: PayrollLockBannerProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [tick, setTick] = useState(0);

  // Reset collapsed state when the lock toggles so a fresh notice shows fully.
  useEffect(() => {
    setCollapsed(false);
  }, [state.locked, state.lockedAt]);

  // Re-render once a minute so the relative time in the banner stays fresh.
  useEffect(() => {
    if (!state.locked) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, [state.locked]);

  const ago = state.locked ? relativeTime(state.lockedAt) : null;
  const operator = state.locked ? startedByLabel(state.lockedBy) : null;
  // tick is a no-op dep just to make the compiler aware we use it
  void tick;

  return (
    <AnimatePresence initial={false}>
      {state.locked && !collapsed && (
        <motion.div
          key="payroll-lock-banner"
          initial={{ height: 0, opacity: 0, y: -6 }}
          animate={{ height: 'auto', opacity: 1, y: 0 }}
          exit={{ height: 0, opacity: 0, y: -6 }}
          transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
          className="overflow-hidden border-b border-rose-300/60 bg-gradient-to-r from-rose-50 via-amber-50 to-rose-50 dark:border-rose-900/50 dark:from-rose-950/40 dark:via-amber-950/30 dark:to-rose-950/40"
          role="status"
          aria-live="polite"
        >
          <div className="relative flex items-center gap-3 px-4 py-2.5 sm:px-6">
            {/* Pulsing ring on the lock icon */}
            <div className="relative flex h-9 w-9 shrink-0 items-center justify-center">
              <span
                className="absolute inset-0 rounded-full bg-rose-400/30 dark:bg-rose-500/20"
                aria-hidden
              />
              <motion.span
                className="absolute inset-0 rounded-full border-2 border-rose-400/60 dark:border-rose-500/60"
                animate={{ scale: [1, 1.5, 1.5], opacity: [0.6, 0, 0] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeOut' }}
                aria-hidden
              />
              <Lock className="relative h-4 w-4 text-rose-600 dark:text-rose-300" aria-hidden />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-[13px] font-semibold text-rose-900 dark:text-rose-100">
                  Payroll is being processed
                </span>
                <span className="text-[11px] text-rose-700/80 dark:text-rose-300/80">
                  Disputes are temporarily paused.
                </span>
              </div>
              {(operator || ago) && (
                <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-rose-800/80 dark:text-rose-300/70">
                  {operator && (
                    <span>
                      Started by{' '}
                      <span className="font-semibold text-rose-900 dark:text-rose-100">{operator}</span>
                    </span>
                  )}
                  {operator && ago && <span aria-hidden>·</span>}
                  {ago && <span>{ago}</span>}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => setCollapsed(true)}
              className={cn(
                'shrink-0 rounded-md p-1 text-rose-700/70 transition-colors',
                'hover:bg-rose-100 hover:text-rose-900',
                'dark:text-rose-300/70 dark:hover:bg-rose-950/50 dark:hover:text-rose-100',
              )}
              aria-label="Dismiss banner"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Progress shimmer along the bottom edge — purely visual, evokes activity */}
          <motion.div
            className="h-[2px] origin-left bg-gradient-to-r from-rose-400 via-amber-400 to-rose-400"
            animate={{ scaleX: [0.2, 1, 0.2] }}
            transition={{ duration: 2.8, repeat: Infinity, ease: 'easeInOut' }}
            aria-hidden
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
