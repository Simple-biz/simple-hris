'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Download,
  FileWarning,
  Gauge,
  Loader2,
  X,
} from 'lucide-react';
import type { PayStubView } from '@/lib/payroll/paystub-view';
import type { PayStubDispatchEntry } from '@/lib/payroll/paystub-dispatch-log';
import type { PaymentDispatchStatus } from '@/lib/supabase/payment-dispatches';
import { downloadPayStubsPdf } from '@/lib/payroll/paystub-export';
import { parseDateOnlyLocal } from '@/lib/date-only';
import { PayStubStatement } from './PayStubStatement';

interface PayStubResponse {
  paystub: PayStubView | null;
  available: boolean;
  paidAt: string | null;
  /** Display pay date: real disbursement date, else the scheduled Tue/Thu. */
  payDate?: string | null;
  status?: string | null;
  /**
   * The roster's CURRENT department for this employee — what the downloaded
   * PDF header names, in place of the department frozen into this week's
   * payload. Returned by both the employee and the accounting route; `null`
   * when there is no active master row (off-boarded), which makes the export
   * fall back to the week's own department.
   */
  currentDepartment?: string | null;
  /**
   * Dispatch attempts logged for this week, with the clerk's notes. Returned
   * ONLY by the accounting route — the employee self-serve route omits the field,
   * so the notes panel below simply never renders for employees.
   */
  dispatches?: PayStubDispatchEntry[];
}

/**
 * Opens the caller's pay statement for one paid week in a smooth modal — the
 * same statement they received by email. `sourceFile` is the Hubstaff pay-week
 * file (a payment_dispatches `cycle_source_file`); the modal fetches the staged
 * paystub itself from `GET /api/employee/paystub`, which is session-scoped so it
 * only ever returns the caller's own pay. Used from the "Salary Paid"
 * notification card and the Overview "Open Paystubs" button.
 *
 * Pass `email` and it reads the ACCOUNTING route instead — any employee's stub,
 * plus that week's dispatch log (Paid / Not paid / Threshold / Problem with the
 * clerk's note) rendered underneath, which is how Payment Dispatch's "View"
 * explains a held or blocked row. Employees never receive that log.
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
        {
          employeeName: data.paystub.name || 'Employee',
          // The CURRENT department, never this week's frozen `paystub.department`:
          // a transfer moves the label on release, so a stub downloaded today must
          // name where the person is today — paid week or not. The exporter falls
          // back to the week's own department when the roster has none.
          department: data.currentDepartment ?? null,
        },
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

  // Portaled to <body>. This overlay is `fixed`, but the dashboards mount inside
  // `<main className="isolate …">` (App.tsx / HrApp) — `isolate` caps every
  // z-index inside main's own stacking context, and main is `overflow-hidden
  // h-full`, so rendered in place the backdrop sized itself to main instead of
  // the viewport: the page header stayed undimmed on top and a tall statement was
  // cut off at the fold with nothing to scroll. Same fix (and same reason) as the
  // MESA receipt lightbox and the co-browse mirror. AnimatePresence lives inside
  // the portal so the exit animation still runs.
  if (typeof document === 'undefined') return null;
  return createPortal(
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
              <>
                <PayStubStatement
                  view={data.paystub}
                  paidAt={data.payDate ?? data.paidAt}
                  status={data.status}
                />
                {/* Accounting-only: why this week did (or didn't) go out. */}
                <DispatchNotes entries={data.dispatches} />
              </>
            ) : (
              <>
                <div className="flex min-h-[240px] w-full max-w-[560px] flex-col items-center justify-center gap-3 rounded-[17px] bg-white px-8 text-center shadow-2xl">
                  <FileWarning className="h-8 w-8 text-zinc-400" />
                  <p className="text-sm font-medium text-zinc-700">
                    No pay statement is available for this week yet.
                  </p>
                  <p className="text-xs text-zinc-500">
                    Your statement opens here once your pay for this week has been sent.
                  </p>
                </div>
                {/* A week can be dispatched (or held) with no statement staged —
                    the log still explains what happened. */}
                <DispatchNotes entries={data?.dispatches} />
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/* ─────────────────── accounting dispatch notes ─────────────────── */

const NOTE_STATUS_UI: Record<
  PaymentDispatchStatus,
  { label: string; chip: string; dot: string; Icon: React.ComponentType<{ className?: string }> }
> = {
  paid: {
    label: 'Paid',
    chip: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    dot: 'bg-emerald-500',
    Icon: CheckCircle2,
  },
  not_paid: {
    label: 'Not paid',
    chip: 'bg-zinc-100 text-zinc-700 ring-zinc-200',
    dot: 'bg-zinc-400',
    Icon: CircleDashed,
  },
  threshold: {
    label: 'Threshold',
    chip: 'bg-amber-50 text-amber-700 ring-amber-200',
    dot: 'bg-amber-500',
    Icon: Gauge,
  },
  problem: {
    label: 'Problem',
    chip: 'bg-rose-50 text-rose-700 ring-rose-200',
    dot: 'bg-rose-500',
    Icon: AlertTriangle,
  },
};

/** "Jul 28, 2026" — `sent_date` is a DATE column, so parse it as a local calendar day. */
function formatLogDate(iso: string | null): string | null {
  const d = parseDateOnlyLocal(iso);
  if (!d) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * The dispatch log for this pay week, under the statement — every outcome the
 * clerk logged (Paid / Not paid / Threshold / Problem) with the note attached to
 * it. So opening "View" on a held row answers *why* it's held instead of showing
 * a statement that looks merely unpaid.
 *
 * Renders nothing when `entries` is absent (the employee self-serve route never
 * sends it — these are internal remarks) or empty (nothing logged yet).
 */
function DispatchNotes({ entries }: { entries?: PayStubDispatchEntry[] }) {
  if (!entries || entries.length === 0) return null;
  return (
    <div
      className="mt-3 w-full max-w-[560px] overflow-hidden rounded-[14px] bg-white shadow-2xl ring-1 ring-black/5"
      style={{ colorScheme: 'light' }}
    >
      <div className="flex items-center justify-between gap-2 border-b border-zinc-100 px-4 py-2.5">
        <span className="text-[10px] font-bold uppercase tracking-[0.11em] text-zinc-500">
          Dispatch log
        </span>
        <span className="text-[11px] text-zinc-400">
          {entries.length === 1 ? '1 entry' : `${entries.length} entries`}
        </span>
      </div>
      <ul className="divide-y divide-zinc-100">
        {entries.map((e) => {
          const ui = NOTE_STATUS_UI[e.status] ?? NOTE_STATUS_UI.not_paid;
          const when = formatLogDate(e.sentDate);
          // Reference line: only the parts actually recorded, so a bare log
          // doesn't render a row of empty separators.
          const meta = [
            e.transactionId ? `Ref ${e.transactionId}` : null,
            e.bankUsed ? `via ${e.bankUsed}` : null,
            e.createdBy,
          ].filter(Boolean) as string[];
          return (
            <li key={e.id} className="px-4 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${ui.chip}`}
                >
                  <ui.Icon className="h-3 w-3" />
                  {ui.label}
                </span>
                {when && <span className="text-[11px] text-zinc-500">{when}</span>}
              </div>
              {e.note ? (
                <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-[17px] text-zinc-700">
                  {e.note}
                </p>
              ) : (
                <p className="mt-1.5 text-[12px] italic leading-[17px] text-zinc-400">
                  No note added.
                </p>
              )}
              {meta.length > 0 && (
                <p className="mt-1 truncate text-[10.5px] text-zinc-400" title={meta.join(' · ')}>
                  {meta.join(' · ')}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
