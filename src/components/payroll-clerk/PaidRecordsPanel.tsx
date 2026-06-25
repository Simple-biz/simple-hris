'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  Download,
  Loader2,
  Search,
  Undo2,
  UserRound,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { formatPHP, formatUSD, formatCOP, PROCESSORS } from './mock-queue';
import QueuePagination from './QueuePagination';
import type { PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';
import {
  buildSentRows,
  dispatchClientFilename,
  downloadCsv,
  sentRowsToCsv,
} from '@/lib/payroll/dispatch-client-csv';

interface PaidRecordsPanelProps {
  /** Dispatch rows for the scope (any status — only status='paid' is shown). */
  records: PaymentDispatchRow[];
  periodStart?: string | null;
  periodEnd?: string | null;
  /** Silent re-pull after a send-back, to reconcile the pending queue. */
  onRefresh: () => void | Promise<void>;
  /** Hide the Processor column (true inside a single-processor "Paid" view). */
  showProcessorColumn?: boolean;
  /** CSV filename prefix (default 'paid'). */
  csvPrefix?: 'paid' | 'done' | 'sent' | 'pending';
  /** Processor id baked into the CSV filename when scoped to one processor. */
  csvProcessor?: string;
  /** Empty-state copy when there are no paid records at all. */
  emptyTitle?: string;
  emptyHint?: string;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

const PAGE_SIZE = 25;

/**
 * Paid-records table shared by the global **Done** tab and each pay processor's
 * **Paid** sub-view. Supports per-row Undo plus a multi-select that bulk-undoes
 * every ticked row in one action — sending them all back to the pay processor as
 * pending. The selection survives search/filter (you can curate it across
 * queries) and is only pruned to rows that still exist after a refresh.
 */
export default function PaidRecordsPanel({
  records,
  periodStart,
  periodEnd,
  onRefresh,
  showProcessorColumn = true,
  csvPrefix = 'paid',
  csvProcessor,
  emptyTitle = 'No payments marked paid yet',
  emptyHint = 'Mark a queue row paid to see it here.',
}: PaidRecordsPanelProps) {
  // Only status='paid' rows are "paid". Threshold/Problem/Not-paid stay in the
  // pending queue for retry, so they never show here.
  const paid = useMemo(() => records.filter((r) => r.status === 'paid'), [records]);

  const [query, setQuery] = useState('');
  // Rows ticked for the bulk "Undo selected" action. Persists across search.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Optimistically hidden rows (sent back, awaiting the silent refresh). Cleared
  // whenever a fresh `records` snapshot arrives.
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  // Rows whose single-row Undo is in flight.
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  // True while a bulk "Undo selected" POST is in flight.
  const [bulkBusy, setBulkBusy] = useState(false);
  const [page, setPage] = useState(1);

  // A fresh snapshot reconciles the optimistic state: drop hidden flags and
  // prune the selection down to rows that still exist (undone rows are gone).
  useEffect(() => {
    setHiddenIds(new Set());
    const liveIds = new Set(paid.map((r) => r.id));
    setSelectedIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) if (liveIds.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [paid]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = paid.filter((r) => !hiddenIds.has(r.id));
    if (q) {
      list = list.filter(
        (r) =>
          (r.recipient_name ?? '').toLowerCase().includes(q) ||
          r.recipient_email.toLowerCase().includes(q) ||
          r.transaction_id.toLowerCase().includes(q) ||
          (r.created_by ?? '').toLowerCase().includes(q),
      );
    }
    return [...list].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  }, [paid, hiddenIds, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  useEffect(() => {
    setPage(1);
  }, [query]);
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);
  const pagedRecords = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page],
  );

  // Select-all operates on the whole (search-)filtered list, across pages — not
  // just the visible page — so one click ticks everything the current filter
  // shows.
  const filteredSelectedCount = filtered.reduce(
    (n, r) => (selectedIds.has(r.id) ? n + 1 : n),
    0,
  );
  const allFilteredSelected = filtered.length > 0 && filteredSelectedCount === filtered.length;
  const someFilteredSelected = filteredSelectedCount > 0 && !allFilteredSelected;
  const selectedCount = selectedIds.size;

  const headerCheckboxRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerCheckboxRef.current) headerCheckboxRef.current.indeterminate = someFilteredSelected;
  }, [someFilteredSelected]);

  const toggleAll = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const r of filtered) next.delete(r.id);
      } else {
        for (const r of filtered) next.add(r.id);
      }
      return next;
    });
  }, [allFilteredSelected, filtered]);

  const toggleOne = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // Shared undo path: delete the dispatch rows so the recipients drop out of
  // paid and reappear in the pending queue. Optimistically hides them, then
  // reconciles from the server via onRefresh.
  const undoIds = useCallback(
    async (ids: string[], label: string) => {
      if (ids.length === 0) return;
      setHiddenIds((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.add(id));
        return next;
      });
      try {
        const res = await fetch('/api/payment-dispatches/undo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        });
        const json = (await res.json()) as { deleted?: number; error?: string };
        if (!res.ok || json.error) throw new Error(json.error ?? 'Could not send back');
        toast.success(label);
        // Silent refresh reconciles the pending queue without a skeleton flash.
        await onRefresh();
      } catch (e) {
        // Restore the optimistically-hidden rows, then reconcile from the
        // server — a batched undo can partially succeed (some rows really were
        // deleted before one batch failed), and the re-pull reflects DB truth.
        setHiddenIds((prev) => {
          const next = new Set(prev);
          ids.forEach((id) => next.delete(id));
          return next;
        });
        toast.error(e instanceof Error ? e.message : 'Could not send back');
        void onRefresh();
        throw e;
      }
    },
    [onRefresh],
  );

  const sendBackOne = useCallback(
    async (row: PaymentDispatchRow) => {
      setBusyIds((prev) => new Set(prev).add(row.id));
      try {
        await undoIds(
          [row.id],
          `${row.recipient_name ?? row.recipient_email} sent back to the pay processor`,
        );
      } catch {
        /* toast already shown */
      } finally {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(row.id);
          return next;
        });
      }
    },
    [undoIds],
  );

  const undoSelected = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    try {
      await undoIds(
        ids,
        `${ids.length} ${ids.length === 1 ? 'payment' : 'payments'} sent back to the pay processor`,
      );
      setSelectedIds(new Set());
    } catch {
      /* toast already shown; selection kept so the user can retry */
    } finally {
      setBulkBusy(false);
    }
  }, [selectedIds, bulkBusy, undoIds]);

  const exportCsv = () => {
    if (filtered.length === 0) return;
    const csv = sentRowsToCsv(buildSentRows(filtered));
    const filename = dispatchClientFilename({
      prefix: csvPrefix,
      processor: csvProcessor,
      periodStart,
      periodEnd,
    });
    downloadCsv(filename, csv);
    toast.success(`Exported ${filtered.length} ${filtered.length === 1 ? 'record' : 'records'}`);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Controls bar */}
      <div className="shrink-0 border-b border-[#ececec] bg-white px-4 py-3 sm:px-6 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
            <CheckCircle2 className="h-3 w-3" />
            {filtered.length} {filtered.length === 1 ? 'payment' : 'payments'} paid
          </span>

          {/* Bulk undo — appears once at least one row is ticked. */}
          {selectedCount > 0 && (
            <div className="inline-flex items-center gap-1.5">
              <button
                type="button"
                onClick={undoSelected}
                disabled={bulkBusy}
                title="Undo every selected payment and send them back to the pay processor as pending"
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 text-[11px] font-semibold text-amber-800 shadow-sm transition-colors hover:border-amber-400 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20"
              >
                {bulkBusy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Undo2 className="h-3 w-3" />
                )}
                Undo selected ({selectedCount})
              </button>
              <button
                type="button"
                onClick={clearSelection}
                disabled={bulkBusy}
                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              >
                <X className="h-3 w-3" />
                Clear
              </button>
            </div>
          )}

          <div className="relative ml-auto w-full max-w-[260px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, email, txn, who paid"
              className="h-8 w-full rounded-md border border-zinc-200 bg-white pl-8 pr-7 text-xs placeholder:text-zinc-400 focus:border-emerald-300 focus:outline-none focus:ring-1 focus:ring-emerald-300/60 dark:border-zinc-700 dark:bg-zinc-900 dark:placeholder:text-zinc-600"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={exportCsv}
            disabled={filtered.length === 0}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-violet-200 bg-white px-2.5 text-[11px] font-semibold text-violet-700 shadow-sm transition-colors hover:border-violet-300 hover:bg-violet-50 disabled:opacity-50 dark:border-violet-500/30 dark:bg-zinc-950 dark:text-violet-300 dark:hover:bg-violet-500/10"
            title={
              filtered.length === 0
                ? 'Nothing to export'
                : `Export ${filtered.length} record(s) as CSV`
            }
          >
            <Download className="h-3 w-3" />
            Export CSV
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] px-3 py-3 sm:px-6 sm:py-6 dark:bg-[#0d1117]">
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center">
            <div>
              <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-zinc-100 text-zinc-400 dark:bg-zinc-900 dark:text-zinc-600">
                <CheckCircle2 className="h-5 w-5" />
              </div>
              <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {paid.length === 0 ? emptyTitle : 'No matches'}
              </h2>
              <p className="mt-1 text-xs text-[#71717a] dark:text-zinc-500">
                {paid.length === 0 ? emptyHint : 'Try a different search.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-[#ececec] bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <table
              className={cn('w-full text-xs', showProcessorColumn ? 'min-w-[1000px]' : 'min-w-[900px]')}
            >
              <thead className="bg-[#fafaf8] text-[10px] uppercase tracking-wide text-[#71717a] dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="w-10 px-4 py-2.5 text-left font-medium">
                    <input
                      ref={headerCheckboxRef}
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={toggleAll}
                      aria-label="Select all paid payments"
                      className="h-3.5 w-3.5 cursor-pointer accent-emerald-600"
                    />
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium">Recipient</th>
                  {showProcessorColumn && (
                    <th className="px-4 py-2.5 text-left font-medium">Processor</th>
                  )}
                  <th className="px-4 py-2.5 text-right font-medium">USD</th>
                  <th className="px-4 py-2.5 text-right font-medium">PHP</th>
                  <th className="px-4 py-2.5 text-left font-medium">Txn ID</th>
                  <th className="px-4 py-2.5 text-left font-medium">Sent</th>
                  <th className="px-4 py-2.5 text-left font-medium">Marked paid</th>
                  <th className="px-4 py-2.5 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#ececec] dark:divide-zinc-800">
                {pagedRecords.map((rec) => {
                  const meta = PROCESSORS.find((p) => p.id === rec.processor);
                  const busy = busyIds.has(rec.id);
                  const checked = selectedIds.has(rec.id);
                  return (
                    <tr
                      key={rec.id}
                      className={cn(
                        'transition-colors hover:bg-[#fafaf8] dark:hover:bg-zinc-900/50',
                        checked && 'bg-emerald-50/60 dark:bg-emerald-500/5',
                      )}
                    >
                      <td className="px-4 py-2.5">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleOne(rec.id)}
                          aria-label={`Select ${rec.recipient_name ?? rec.recipient_email}`}
                          className="h-3.5 w-3.5 cursor-pointer accent-emerald-600"
                        />
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-zinc-900 dark:text-zinc-100">
                          {rec.recipient_name ?? rec.recipient_email}
                        </div>
                        <div className="font-mono text-[10px] text-[#71717a] dark:text-zinc-500">
                          {rec.recipient_email}
                        </div>
                      </td>
                      {showProcessorColumn && (
                        <td className="px-4 py-2.5 text-zinc-700 dark:text-zinc-300">
                          {meta?.label ?? rec.processor}
                        </td>
                      )}
                      <td className="px-4 py-2.5 text-right font-mono font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                        {rec.amount_cop != null ? formatCOP(rec.amount_cop) : formatUSD(rec.amount_usd)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-zinc-600 dark:text-zinc-400">
                        {formatPHP(rec.amount_php)}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
                        {rec.transaction_id}
                      </td>
                      <td className="px-4 py-2.5 text-zinc-700 dark:text-zinc-300">
                        {rec.sent_date}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1 text-zinc-700 dark:text-zinc-300">
                          <Clock className="h-3 w-3 text-zinc-400" />
                          {formatTimestamp(rec.created_at)}
                        </div>
                        {rec.created_by && (
                          <div className="mt-0.5 flex items-center gap-1 font-mono text-[10px] text-[#71717a] dark:text-zinc-500">
                            <UserRound className="h-2.5 w-2.5" />
                            {rec.created_by}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => sendBackOne(rec)}
                          disabled={busy || bulkBusy}
                          title="Undo this payment and send it back to the pay processor"
                          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-amber-200 bg-white px-2.5 text-[11px] font-medium text-amber-700 transition-colors hover:border-amber-300 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-500/30 dark:bg-zinc-950 dark:text-amber-300 dark:hover:bg-amber-500/10"
                        >
                          {busy ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Undo2 className="h-3 w-3" />
                          )}
                          Undo
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <QueuePagination
              page={page}
              pageCount={pageCount}
              total={filtered.length}
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
