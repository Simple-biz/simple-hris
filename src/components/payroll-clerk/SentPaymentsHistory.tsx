'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, Download, Gauge } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { formatPHP, formatUSD, PROCESSORS } from './mock-queue';
import QueuePagination from './QueuePagination';
import type {
  PaymentDispatchRow,
  PaymentDispatchStatus,
} from '@/lib/supabase/payment-dispatches';
import {
  buildSentRows,
  dispatchClientFilename,
  downloadCsv,
  sentRowsToCsv,
} from '@/lib/payroll/dispatch-client-csv';

const STATUS_PRESENTATION: Record<
  PaymentDispatchStatus,
  { label: string; Icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  paid: {
    label: 'Paid',
    Icon: CheckCircle2,
    className:
      'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
  },
  not_paid: {
    label: 'Not Paid',
    Icon: CircleDashed,
    className:
      'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300',
  },
  threshold: {
    label: 'Threshold',
    Icon: Gauge,
    className:
      'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
  },
  problem: {
    label: 'Problem',
    Icon: AlertTriangle,
    className:
      'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300',
  },
};

function StatusBadge({ status }: { status: PaymentDispatchStatus }) {
  const meta = STATUS_PRESENTATION[status] ?? STATUS_PRESENTATION.paid;
  const { Icon } = meta;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        meta.className,
      )}
    >
      <Icon className="h-2.5 w-2.5" />
      {meta.label}
    </span>
  );
}

interface SentPaymentsHistoryProps {
  records: PaymentDispatchRow[];
  /** Period info passed from PayrollDispatch — used for the CSV filename. */
  periodStart?: string | null;
  periodEnd?: string | null;
}

export default function SentPaymentsHistory({
  records,
  periodStart,
  periodEnd,
}: SentPaymentsHistoryProps) {
  const PAGE_SIZE = 25;
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);
  const pagedRecords = useMemo(
    () => records.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [records, page],
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[#ececec] bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
              Sent payments
            </h1>
            <p className="mt-1 text-xs text-[#71717a] dark:text-zinc-500">
              Confirmations Lenny logged for the current pay cycle. Persisted in <span className="font-mono">payment_dispatches</span>.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              if (records.length === 0) return;
              const csv = sentRowsToCsv(buildSentRows(records));
              const filename = dispatchClientFilename({
                prefix: 'sent',
                periodStart,
                periodEnd,
              });
              downloadCsv(filename, csv);
              toast.success(
                `Exported ${records.length} ${records.length === 1 ? 'record' : 'records'}`,
              );
            }}
            disabled={records.length === 0}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-emerald-200 bg-white px-2.5 text-[11px] font-semibold text-emerald-700 shadow-sm transition-colors hover:border-emerald-300 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-500/30 dark:bg-zinc-950 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
            title={
              records.length === 0
                ? 'Nothing to export — no payments logged this cycle yet'
                : `Export ${records.length} ${records.length === 1 ? 'record' : 'records'} as CSV`
            }
          >
            <Download className="h-3 w-3" />
            Export CSV
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] px-3 py-3 sm:px-6 sm:py-6 dark:bg-[#0d1117]">
        {records.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center">
            <div>
              <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-zinc-100 text-zinc-400 dark:bg-zinc-900 dark:text-zinc-600">
                <CheckCircle2 className="h-5 w-5" />
              </div>
              <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">No payments logged yet</h2>
              <p className="mt-1 text-xs text-[#71717a] dark:text-zinc-500">
                Mark a queue row paid to see it here.
              </p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-[#ececec] bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <table className="w-full min-w-[1080px] text-xs">
              <thead className="bg-[#fafaf8] text-[10px] uppercase tracking-wide text-[#71717a] dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">Recipient</th>
                  <th className="px-4 py-2.5 text-left font-medium">Status</th>
                  <th className="px-4 py-2.5 text-left font-medium">Processor</th>
                  <th className="px-4 py-2.5 text-right font-medium">USD</th>
                  <th className="px-4 py-2.5 text-right font-medium">PHP</th>
                  <th className="px-4 py-2.5 text-left font-medium">Sent to</th>
                  <th className="px-4 py-2.5 text-left font-medium">Bank used</th>
                  <th className="px-4 py-2.5 text-left font-medium">Txn ID</th>
                  <th className="px-4 py-2.5 text-left font-medium">Sent</th>
                  <th className="px-4 py-2.5 text-left font-medium">Arrival</th>
                  <th className="px-4 py-2.5 text-left font-medium">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#ececec] dark:divide-zinc-800">
                {pagedRecords.map((rec) => {
                  const meta = PROCESSORS.find((p) => p.id === rec.processor);
                  return (
                    <tr key={rec.id} className="hover:bg-[#fafaf8] dark:hover:bg-zinc-900/50">
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-zinc-900 dark:text-zinc-100">
                          {rec.recipient_name ?? rec.recipient_email}
                        </div>
                        <div className="font-mono text-[10px] text-[#71717a] dark:text-zinc-500">
                          {rec.recipient_email}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge status={rec.status} />
                      </td>
                      <td className="px-4 py-2.5 text-zinc-700 dark:text-zinc-300">
                        {meta?.label ?? rec.processor}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                        {formatUSD(rec.amount_usd)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-zinc-600 dark:text-zinc-400">
                        {formatPHP(rec.amount_php)}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="text-zinc-700 dark:text-zinc-300">
                          {rec.recipient_preferred_bank || <span className="text-zinc-400">—</span>}
                        </div>
                        {rec.recipient_account_number && (
                          <div className="font-mono text-[10px] text-[#71717a] dark:text-zinc-500">
                            {rec.recipient_account_number}
                          </div>
                        )}
                        {rec.recipient_account_holder &&
                          rec.recipient_account_holder !== rec.recipient_name && (
                            <div className="text-[10px] italic text-[#71717a] dark:text-zinc-500">
                              {rec.recipient_account_holder}
                            </div>
                          )}
                        {rec.recipient_swift_code && (
                          <div className="font-mono text-[10px] text-amber-700 dark:text-amber-400">
                            SWIFT {rec.recipient_swift_code}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-zinc-700 dark:text-zinc-300">{rec.bank_used}</td>
                      <td className="px-4 py-2.5 font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
                        {rec.transaction_id}
                      </td>
                      <td className="px-4 py-2.5 text-zinc-700 dark:text-zinc-300">{rec.sent_date}</td>
                      <td className="px-4 py-2.5 text-zinc-700 dark:text-zinc-300">
                        {rec.arrival_date || '—'}
                      </td>
                      <td className="max-w-[220px] px-4 py-2.5 text-zinc-700 dark:text-zinc-300">
                        {rec.note ? (
                          <span className="line-clamp-2 text-[11px] leading-snug" title={rec.note}>
                            {rec.note}
                          </span>
                        ) : (
                          <span className="text-zinc-400">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <QueuePagination
              page={page}
              pageCount={pageCount}
              total={records.length}
              pageSize={PAGE_SIZE}
              onPageChange={setPage}
              label="records"
            />
          </div>
        )}
      </div>
    </div>
  );
}
