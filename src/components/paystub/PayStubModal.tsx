'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Loader2, X, FileWarning, Download } from 'lucide-react';
import type { PayStubView } from '@/lib/payroll/paystub-view';
import { downloadPayStubsPdf } from '@/lib/payroll/paystub-export';
import { PayStubStatement } from './PayStubStatement';

interface PayStubResponse {
  paystub: PayStubView | null;
  available: boolean;
  paidAt: string | null;
  /** Display pay date: real disbursement date, else the scheduled Tue/Thu. */
  payDate?: string | null;
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
  email,
}: {
  open: boolean;
  sourceFile: string | null;
  onClose: () => void;
  /** When set, fetch the ACCOUNTING route for THIS employee's stub (any employee).
   *  Omit for the self-serve employee view (session-scoped to the caller). */
  email?: string | null;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PayStubResponse | null>(null);
  const [downloading, setDownloading] = useState(false);

  // Fetch whenever we open on a (new) week. Accounting passes an explicit email →
  // the accounting route; the employee self-serve view uses the session-scoped one.
  useEffect(() => {
    if (!open || !sourceFile) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    const url = email
      ? `/api/accounting/paystub?source_file=${encodeURIComponent(sourceFile)}&email=${encodeURIComponent(email)}`
      : `/api/employee/paystub?source_file=${encodeURIComponent(sourceFile)}`;
    fetch(url, { cache: 'no-store' })
      .then(async (res) => {
        const json = (await res.json()) as PayStubResponse & { error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error || 'Could not load the pay statement.');
          return;
        }
        setData(json);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load the pay statement.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sourceFile, email]);

  // Download THIS single week's statement as a branded PDF (loading-animated).
  const handleDownload = useCallback(async () => {
    if (!sourceFile || !data?.paystub) return;
    setDownloading(true);
    try {
      await downloadPayStubsPdf(
        [{ sourceFile, paidAt: data.payDate ?? data.paidAt, status: data.status, view: data.paystub }],
        { employeeName: data.paystub.name || 'Employee', department: data.paystub.department },
      );
    } finally {
      setDownloading(false);
    }
  }, [sourceFile, data]);

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
            {/* Download this week's statement as a PDF (loading-animated). */}
            {data?.paystub && data.available && !loading && !error && (
              <button
                type="button"
                onClick={handleDownload}
                disabled={downloading}
                aria-label="Download pay statement PDF"
                title="Download PDF"
                className="absolute -left-1 -top-1 z-10 inline-flex h-8 items-center justify-center gap-1.5 rounded-full bg-white px-3 text-[12px] font-medium text-zinc-700 shadow-md ring-1 ring-black/10 transition hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:cursor-not-allowed disabled:opacity-60 sm:-left-3 sm:-top-3"
              >
                {downloading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                {downloading ? 'Preparing…' : 'PDF'}
              </button>
            )}

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
                  <span className="text-sm">Loading pay statement…</span>
                </div>
              </div>
            ) : error ? (
              <div className="flex min-h-[240px] w-full max-w-[560px] flex-col items-center justify-center gap-3 rounded-[17px] bg-white px-8 text-center shadow-2xl">
                <FileWarning className="h-8 w-8 text-amber-500" />
                <p className="text-sm font-medium text-zinc-700">{error}</p>
              </div>
            ) : data?.paystub && data.available ? (
              <PayStubStatement
                view={data.paystub}
                paidAt={data.payDate ?? data.paidAt}
                status={data.status}
              />
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
