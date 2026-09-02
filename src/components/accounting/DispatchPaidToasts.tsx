'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ArrowRight, Wallet, X } from 'lucide-react';
import { useDispatchPaidToasts } from '@/hooks/useDispatchPaidToasts';
import {
  formatPaidLine,
  paidAmountParts,
  type PaidToastEvent,
} from '@/lib/payroll/dispatch-paid-toast';

/**
 * Lower-left "X paid Y $Z" cards, one per PAID dispatch row, shown on every
 * Accounting tab while processing is ON. Its own fixed stack rather than a
 * sonner toast: the Accounting Toaster is top-right and teal by rule
 * (docs/features/notification-alerts.md), and this card's motion is the point —
 * it slides IN from the left edge, rests, and leaves to the right.
 *
 * Reduced motion: opacity only, same timing (ui-standards §14.5).
 */
export default function DispatchPaidToasts({
  locked,
  selfEmail,
}: {
  locked: boolean;
  /** The viewer — their own payments arrive from the local path, never the poll. */
  selfEmail: string | null | undefined;
}) {
  const { stack, dismiss } = useDispatchPaidToasts(locked, selfEmail);
  const reduce = useReducedMotion() ?? false;
  if (!locked) return null;

  return (
    <div
      aria-live="polite"
      aria-relevant="additions"
      className="pointer-events-none fixed bottom-4 left-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2"
    >
      <AnimatePresence initial={false}>
        {stack.map((evt) => (
          <PaidCard key={evt.id} evt={evt} reduce={reduce} onDismiss={() => dismiss(evt.id)} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function PaidCard({
  evt,
  reduce,
  onDismiss,
}: {
  evt: PaidToastEvent;
  reduce: boolean;
  onDismiss: () => void;
}) {
  const { primary, secondary } = paidAmountParts(evt);
  return (
    <motion.div
      layout={!reduce}
      role="status"
      aria-label={formatPaidLine(evt)}
      initial={reduce ? { opacity: 0 } : { opacity: 0, x: -56 }}
      animate={{ opacity: 1, x: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, x: 28, transition: { duration: 0.22, ease: 'easeIn' } }}
      transition={
        reduce
          ? { duration: 0.2 }
          : { type: 'spring', stiffness: 420, damping: 34, mass: 0.9, opacity: { duration: 0.22 } }
      }
      className="pointer-events-auto relative overflow-hidden rounded-xl border border-emerald-200/70 bg-white shadow-lg shadow-emerald-950/10 dark:border-emerald-800/50 dark:bg-zinc-900 dark:shadow-black/40"
    >
      {/* Emerald "money moved" stripe */}
      <div className="absolute inset-y-0 left-0 w-1.5 bg-gradient-to-b from-emerald-400 via-emerald-500 to-teal-600" />

      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
      >
        <X className="h-3.5 w-3.5" />
      </button>

      <div className="flex items-center gap-3 py-3 pl-5 pr-9">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-50 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:ring-emerald-800/70">
          <Wallet className="h-[18px] w-[18px] text-emerald-600 dark:text-emerald-400" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-1.5 text-[12.5px] leading-tight text-zinc-500 dark:text-zinc-400">
            <span className="truncate font-semibold text-zinc-900 dark:text-zinc-100" title={evt.by}>
              {evt.by}
            </span>
            <span className="shrink-0">paid</span>
          </p>
          <p
            className="mt-0.5 flex min-w-0 items-center gap-1 text-[13px] font-semibold leading-tight text-zinc-900 dark:text-zinc-100"
            title={evt.recipientName ? `${evt.recipientName} · ${evt.recipientEmail}` : evt.recipientEmail}
          >
            <ArrowRight className="h-3 w-3 shrink-0 text-emerald-500" />
            <span className="truncate">{evt.recipientEmail}</span>
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end leading-tight">
          <span className="text-[15px] font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
            {primary}
          </span>
          {secondary && (
            <span className="text-[10.5px] tabular-nums text-zinc-400 dark:text-zinc-500">{secondary}</span>
          )}
        </div>
      </div>
    </motion.div>
  );
}
