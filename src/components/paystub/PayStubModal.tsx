'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Loader2, X, FileWarning } from 'lucide-react';
import type { PayStubView } from '@/lib/payroll/paystub-view';
import { PayStubStatement } from './PayStubStatement';

interface PayStubResponse {
  paystub: PayStubView | null;
  available: boolean;
  paidAt: string | null;
  status?: string | null;
}

/**
 * Opens the caller's pay statement for one paid week in a smooth modal — the
 * same statement they received by email. `sourceFile` is the Hubstaff pay-week
 * file (a payment_dispatches `cycle_source_file`); the modal fetches the staged
 * paystub itself from `GET /api/employee/paystub`, which is session-scoped so it
 * only ever returns the caller's own pay. Used from the "Salary Paid"
 * notification card and the Overview "Open Paystubs" button.
 */
export function PayStubModal({
  open,
  sourceFile,
  onClose,
}: {
  open: boolean;
  sourceFile: string | null;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PayStubResponse | null>(null);

  // Fetch whenever we open on a (new) week.
  useEffect(() => {
    if (!open || !sourceFile) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    fetch(`/api/employee/paystub?source_file=${encodeURIComponent(sourceFile)}`)
      .then(async (res) => {
        const json = (await res.json()) as PayStubResponse & { error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error || 'Could not load your pay statement.');
          return;
        }
        setData(json);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load your pay statement.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sourceFile]);

  // Esc to close + lock body scroll while open.
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );
  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = prev;
    };
  }, [open, handleKey]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-black/55 p-4 backdrop-blur-sm sm:items-center sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          onClick={onClose}
          role="dialog"
          aria-modal="true"
          aria-label="Pay statement"
        >
          <motion.div
            className="relative my-auto w-full max-w-[560px]"
            initial={{ opacity: 0, y: 14, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={onClose}
              aria-label="Close pay statement"
              className="absolute -right-1 -top-1 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full bg-white text-zinc-600 shadow-md ring-1 ring-black/10 transition hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 sm:-right-3 sm:-top-3"
            >
              <X className="h-4 w-4" />
            </button>

            {loading ? (
              <div className="flex min-h-[280px] w-full max-w-[560px] items-center justify-center rounded-[17px] bg-white shadow-2xl">
                <div className="flex flex-col items-center gap-3 text-zinc-500">
                  <Loader2 className="h-6 w-6 animate-spin text-orange-500" />
                  <span className="text-sm">Loading your pay statement…</span>
                </div>
              </div>
            ) : error ? (
              <div className="flex min-h-[240px] w-full max-w-[560px] flex-col items-center justify-center gap-3 rounded-[17px] bg-white px-8 text-center shadow-2xl">
                <FileWarning className="h-8 w-8 text-amber-500" />
                <p className="text-sm font-medium text-zinc-700">{error}</p>
              </div>
            ) : data?.paystub && data.available ? (
              <PayStubStatement view={data.paystub} paidAt={data.paidAt} />
            ) : (
              <div className="flex min-h-[240px] w-full max-w-[560px] flex-col items-center justify-center gap-3 rounded-[17px] bg-white px-8 text-center shadow-2xl">
                <FileWarning className="h-8 w-8 text-zinc-400" />
                <p className="text-sm font-medium text-zinc-700">
                  No pay statement is available for this week yet.
                </p>
                <p className="text-xs text-zinc-500">
                  Your statement opens here once your pay for this week has been sent.
                </p>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
