'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Check, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The "Creating invoice" overlay shown while Orders locks (Kane, 2026-09-23).
 *
 * Every step it shows is a REAL phase of the lock, never a timer:
 *   locking → the POST is in flight (server re-prices + writes the order)
 *   pdf     → the order exists; the PDF is being built in the browser
 *   done    → both finished; held briefly so the stamp can land, then closed
 * A failure closes it immediately (the toast says why) — it never plays a
 * success animation over a lock that did not happen.
 */
export type InvoicePhase = 'locking' | 'pdf' | 'done';

const STEPS: { phase: InvoicePhase; label: string }[] = [
  { phase: 'locking', label: 'Checking prices & locking order' },
  { phase: 'pdf', label: 'Creating invoice' },
  { phase: 'done', label: 'Invoice ready' },
];
const ORDER: InvoicePhase[] = ['locking', 'pdf', 'done'];

export default function InvoiceProgress({
  phase,
  invoiceNo,
  giftCount,
}: {
  phase: InvoicePhase | null;
  invoiceNo: string | null;
  giftCount: number;
}) {
  const reduce = !!useReducedMotion();
  const at = phase ? ORDER.indexOf(phase) : -1;

  return (
    <AnimatePresence>
      {phase && (
        <motion.div
          key="invoice-progress"
          className="fixed inset-0 z-[80] flex items-center justify-center bg-zinc-950/35 px-4 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.2 }}
        >
          <motion.div
            role="status"
            aria-live="polite"
            className="w-full max-w-sm rounded-2xl border border-emerald-100 bg-white p-6 shadow-2xl shadow-emerald-900/20 dark:border-emerald-900/50 dark:bg-zinc-950"
            initial={reduce ? false : { y: 12, scale: 0.97, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={reduce ? undefined : { y: 8, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            {/* The document being written. */}
            <div className="relative mx-auto mb-5 h-36 w-28">
              <motion.div
                className="absolute inset-0 rounded-lg border border-zinc-200 bg-gradient-to-b from-white to-emerald-50/60 shadow-md dark:border-zinc-700 dark:from-zinc-900 dark:to-emerald-950/30"
                animate={reduce || phase === 'done' ? { y: 0 } : { y: [0, -3, 0] }}
                transition={{ duration: 1.8, repeat: reduce || phase === 'done' ? 0 : Infinity, ease: 'easeInOut' }}
              >
                <div className="h-1.5 rounded-t-lg bg-gradient-to-r from-emerald-500 to-teal-600" />
                <div className="flex flex-col gap-2 px-3 pt-3">
                  <div className="h-2 w-10 rounded bg-emerald-600/80" />
                  {[0.9, 0.7, 0.8, 0.55, 0.75].map((w, i) => (
                    <motion.div
                      key={i}
                      className="h-1.5 origin-left rounded bg-zinc-300 dark:bg-zinc-600"
                      style={{ width: `${w * 100}%` }}
                      initial={{ scaleX: reduce ? 1 : 0 }}
                      animate={{ scaleX: at >= 1 || reduce ? 1 : i < 2 ? 1 : 0.15 }}
                      transition={{ duration: 0.45, delay: reduce ? 0 : 0.12 * i, ease: 'easeOut' }}
                    />
                  ))}
                  <div className="mt-1 flex justify-end">
                    <motion.div
                      className="h-2 w-8 rounded bg-emerald-500/70"
                      initial={{ scaleX: reduce ? 1 : 0 }}
                      animate={{ scaleX: at >= 1 || reduce ? 1 : 0 }}
                      style={{ originX: 1 }}
                      transition={{ duration: 0.4, delay: reduce ? 0 : 0.5 }}
                    />
                  </div>
                </div>
              </motion.div>

              {/* The LOCKED stamp lands only once everything really finished. */}
              <AnimatePresence>
                {phase === 'done' && (
                  <motion.div
                    className="absolute -right-5 bottom-3 flex -rotate-12 items-center gap-1 rounded-md border-2 border-emerald-600 bg-white/90 px-2 py-0.5 text-[11px] font-black tracking-widest text-emerald-700 dark:bg-zinc-950/90 dark:text-emerald-300"
                    initial={reduce ? false : { scale: 2.2, opacity: 0, rotate: -30 }}
                    animate={{ scale: 1, opacity: 1, rotate: -12 }}
                    transition={{ type: 'spring', stiffness: 420, damping: 18 }}
                  >
                    <Check className="h-3 w-3" strokeWidth={3} />
                    LOCKED
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <p className="text-center text-base font-semibold text-zinc-900 dark:text-zinc-100">
              {phase === 'done' ? `${invoiceNo ?? 'Invoice'} is ready` : 'Creating invoice…'}
            </p>
            <p className="mt-0.5 text-center text-xs text-zinc-500 dark:text-zinc-400">
              {giftCount} gift{giftCount === 1 ? '' : 's'} · don&rsquo;t close this tab
            </p>

            <ol className="mt-5 flex flex-col gap-2.5">
              {STEPS.map((s, i) => {
                const state = i < at || phase === 'done' ? 'done' : i === at ? 'active' : 'waiting';
                return (
                  <li key={s.phase} className="flex items-center gap-2.5 text-sm">
                    <span
                      className={cn(
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors',
                        state === 'done' && 'border-emerald-600 bg-emerald-600 text-white',
                        state === 'active' && 'border-emerald-500 text-emerald-600 dark:text-emerald-400',
                        state === 'waiting' && 'border-zinc-300 text-transparent dark:border-zinc-700',
                      )}
                    >
                      {state === 'done' ? (
                        <Check className="h-3 w-3" strokeWidth={3} />
                      ) : state === 'active' ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        state === 'waiting' ? 'text-zinc-400 dark:text-zinc-600' : 'text-zinc-800 dark:text-zinc-200',
                        state === 'active' && 'font-medium',
                      )}
                    >
                      {s.phase === 'done' && invoiceNo ? `${s.label} — ${invoiceNo}` : s.label}
                    </span>
                  </li>
                );
              })}
            </ol>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
