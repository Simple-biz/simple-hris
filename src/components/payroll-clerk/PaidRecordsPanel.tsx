'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Clock,
  Download,
  Gauge,
  Loader2,
  Receipt,
  Search,
  Undo2,
  UserRound,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { SmoothSelect } from '@/components/ui/smooth-select';
import { formatPHP, formatUSD, formatCOP, PROCESSORS } from './mock-queue';
import QueuePagination from './QueuePagination';
import ContractorChip from './ContractorChip';
import DeptChip from './DeptChip';
import { PayStubModal } from '@/components/paystub/PayStubModal';
import type { PaymentDispatchRow, PaymentDispatchStatus } from '@/lib/supabase/payment-dispatches';
import {
  buildSentRows,
  dispatchClientFilename,
  downloadCsv,
  sentRowsToCsv,
} from '@/lib/payroll/dispatch-client-csv';

/**
 * Per-status presentation for the records panel. `paid` is the original green
 * "already sent" view; the other three are the non-paid dispatch outcomes —
 * logged, but no money actually moved.
 *
 * Not Paid leaves the person in the pending queue for a retry. `threshold` and
 * `problem` do NOT: a held or flagged person is pulled out of pending (see
 * `lockedEmails` in useDispatchQueue) and only comes back when the row is cleared
 * from here. Colors mirror the status pills in the Mark Paid dialog.
 */
const STATUS_UI: Record<
  PaymentDispatchStatus,
  {
    noun: string;               // singular label used in the count pill ("payment", "problem"…)
    verbed: string;             // past-tense state word ("paid", "logged as problem"…)
    pill: string;               // count-pill classes
    Icon: React.ComponentType<{ className?: string }>;
    /** Whether these rows can be "sent back" (undone) — retry markers can, paid can. */
  }
> = {
  paid: {
    noun: 'payment',
    verbed: 'paid',
    pill: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
    Icon: CheckCircle2,
  },
  not_paid: {
    noun: 'dispatch',
    verbed: 'logged not paid',
    pill: 'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300',
    Icon: CircleDashed,
  },
  threshold: {
    noun: 'dispatch',
    verbed: 'below threshold',
    pill: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
    Icon: Gauge,
  },
  problem: {
    noun: 'dispatch',
    verbed: 'flagged problem',
    pill: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300',
    Icon: AlertTriangle,
  },
};

/** Sentinel dept-filter value for records whose payee resolves to no department
 *  (real names can't collide with it — departments never start with "__"). */
const NO_DEPT = '__none__';

interface PaidRecordsPanelProps {
  /** Dispatch rows for the scope (any status — filtered to `statusFilter`). */
  records: PaymentDispatchRow[];
  /**
   * Lowercased email → department name for this cycle
   * ({@link DispatchQueueState.deptByEmail}), which is how these rows get a
   * department at all: `payment_dispatches` has no department column, and a paid
   * person is filtered out of the pending queue. Required rather than optional so
   * a new caller can't silently ship a panel where every row reads "No department".
   */
  deptByEmail: Record<string, string>;
  /**
   * Which dispatch status this panel shows. Defaults to 'paid' (the Done /
   * per-processor Paid view). The non-paid outcomes reuse this same panel so
   * the clerk can review — and send back for retry — what didn't go through.
   */
  statusFilter?: PaymentDispatchStatus;
  periodStart?: string | null;
  periodEnd?: string | null;
  /** Silent re-pull after a send-back, to reconcile the pending queue. */
  onRefresh: () => void | Promise<void>;
  /**
   * Show the "From Bank" column — the send-from rail this dispatch went out on.
   * False inside a single-processor sub-view, where every row shares one rail and
   * the column would just repeat the tab you're standing in.
   */
  showFromBankColumn?: boolean;
  /** CSV filename prefix (default 'paid'). */
  csvPrefix?: 'paid' | 'done' | 'sent' | 'pending';
  /** Processor id baked into the CSV filename when scoped to one processor. */
  csvProcessor?: string;
  /** Empty-state copy when there are no paid records at all. */
  emptyTitle?: string;
  emptyHint?: string;
}

function copyText(value: string) {
  void navigator.clipboard
    .writeText(value)
    .then(() => toast.success('Copied'))
    .catch(() => toast.error('Could not copy'));
}

/**
 * "System Bonus" column cell — reads the SNAPSHOT `system_bonus_php` /
 * `system_bonus_label` the mark-paid path froze onto the row (see BonusChip
 * in ProcessorQueue.tsx for the Pending-side equivalent), rather than
 * recomputing from Hubstaff hours. Rows written before
 * `add_system_bonus_to_payment_dispatches.sql` have neither field, so the
 * caller renders a dash instead of this.
 */
function SystemBonusCell({ amount, label }: { amount: number; label: string | null }) {
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span
        className="font-mono text-[12px] font-semibold tabular-nums text-emerald-700 dark:text-emerald-300"
        title="Already included in the PHP Value total"
      >
        {formatPHP(amount)}
      </span>
      {label && (
        <span className="max-w-[9.5rem] truncate text-[10px] text-emerald-600/80 dark:text-emerald-400/70" title={label}>
          {label}
        </span>
      )}
    </div>
  );
}

/**
 * "To Recipient Bank" for a logged dispatch — read from the SNAPSHOT the mark-paid
 * path froze onto the row (`recipient_*`), never re-resolved from the employee's
 * current profile, so a historical record keeps showing where the money actually
 * went even after they change banks. Mirrors the pending queue's column of the same
 * name; rows written before those columns existed simply have nothing to show.
 */
function RecordRecipientBank({ rec }: { rec: PaymentDispatchRow }) {
  const label = (rec.recipient_preferred_bank ?? '').trim();
  const account = (rec.recipient_account_number ?? '').trim();
  const holder = (rec.recipient_account_holder ?? '').trim();
  const swift = (rec.recipient_swift_code ?? '').trim();
  if (!label && !account) {
    return (
      <span className="text-[11px] text-[#71717a] dark:text-zinc-500" title="No receiving details were recorded on this dispatch">
        Not recorded
      </span>
    );
  }
  const showHolder =
    holder !== '' && holder.toLowerCase() !== (rec.recipient_name ?? '').trim().toLowerCase();
  return (
    <div className="flex min-w-0 flex-col items-start gap-0.5">
      <span className="max-w-full truncate font-medium text-zinc-700 dark:text-zinc-300" title={swift ? `${label} · SWIFT ${swift}` : label}>
        {label || '—'}
      </span>
      {account && (
        <button
          type="button"
          onClick={() => copyText(account)}
          title={`${account} — click to copy`}
          className="max-w-full truncate text-left font-mono text-[10px] text-[#71717a] transition-colors hover:text-orange-700 dark:text-zinc-500 dark:hover:text-orange-300"
        >
          {account}
        </button>
      )}
      {showHolder && (
        <span className="max-w-full truncate text-[10px] text-zinc-400 dark:text-zinc-500" title={`Account holder: ${holder}`}>
          {holder}
        </span>
      )}
    </div>
  );
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
  deptByEmail,
  statusFilter = 'paid',
  periodStart,
  periodEnd,
  onRefresh,
  showFromBankColumn = true,
  csvPrefix = 'paid',
  csvProcessor,
  emptyTitle = 'No payments marked paid yet',
  emptyHint = 'Mark a queue row paid to see it here.',
}: PaidRecordsPanelProps) {
  const ui = STATUS_UI[statusFilter];
  const isPaidView = statusFilter === 'paid';
  // Rows for this view = dispatches logged with the selected status. For 'paid'
  // that's money actually sent; the other three are markers where money never
  // moved — Not Paid keeps the person payable in the pending queue, 'threshold'
  // and 'problem' hold them out of it until the row is cleared.
  const paid = useMemo(
    () => records.filter((r) => r.status === statusFilter),
    [records, statusFilter],
  );

  const [query, setQuery] = useState('');
  // '' = every department; NO_DEPT = records whose payee resolves to none; else an
  // exact department name.
  const [deptFilter, setDeptFilter] = useState('');
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
  // "View" → the pay stub for the week this dispatch settled. Scoped to the
  // record's OWN cycle_source_file (not the tab's current week) so an old record
  // opens the statement it actually paid. The stub's header pill follows the
  // dispatch status: green "Paid" here in the Paid view, orange "Pending" for a
  // Not paid / Threshold / Problem row, where no money moved.
  const [viewStub, setViewStub] = useState<{ sourceFile: string; email: string } | null>(null);

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

  // Department of the person a record paid. Null when no source in this cycle
  // could place them — they stay visible under "No department" rather than
  // dropping out of the table.
  const deptOf = useCallback(
    (rec: PaymentDispatchRow): string | null =>
      deptByEmail[rec.recipient_email.trim().toLowerCase()] ?? null,
    [deptByEmail],
  );

  // Departments present in THESE records, for the filter dropdown. Built off the
  // unfiltered status list (not the searched one) so the options don't shift under
  // the pointer while typing. The "No department" bucket appears only when some
  // record actually has none.
  const deptOptions = useMemo(() => {
    const names = new Set<string>();
    let hasNone = false;
    for (const r of paid) {
      const name = deptOf(r);
      if (name) names.add(name);
      else hasNone = true;
    }
    const opts = [
      { value: '', label: 'All departments' },
      ...[...names].sort((a, b) => a.localeCompare(b)).map((n) => ({ value: n, label: n })),
    ];
    if (hasNone) opts.push({ value: NO_DEPT, label: 'No department' });
    return opts;
  }, [paid, deptOf]);

  // A department that disappears from the records (undo, a refresh, a status
  // switch) must not leave the panel filtered to nothing with no way back — drop
  // the selection to "All departments" instead.
  useEffect(() => {
    if (deptFilter && !deptOptions.some((o) => o.value === deptFilter)) setDeptFilter('');
  }, [deptOptions, deptFilter]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = paid.filter((r) => !hiddenIds.has(r.id));
    if (deptFilter) {
      list =
        deptFilter === NO_DEPT
          ? list.filter((r) => deptOf(r) == null)
          : list.filter((r) => deptOf(r) === deptFilter);
    }
    if (q) {
      list = list.filter(
        (r) =>
          (r.recipient_name ?? '').toLowerCase().includes(q) ||
          r.recipient_email.toLowerCase().includes(q) ||
          r.transaction_id.toLowerCase().includes(q) ||
          (deptOf(r) ?? '').toLowerCase().includes(q) ||
          (r.created_by ?? '').toLowerCase().includes(q),
      );
    }
    return [...list].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  }, [paid, hiddenIds, query, deptFilter, deptOf]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  useEffect(() => {
    setPage(1);
  }, [query, deptFilter]);
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
      const who = row.recipient_name ?? row.recipient_email;
      try {
        await undoIds(
          [row.id],
          isPaidView
            ? `${who} sent back to the pay processor`
            : `${who}'s ${ui.verbed} record cleared`,
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
    [undoIds, isPaidView, ui.verbed],
  );

  const undoSelected = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    try {
      await undoIds(
        ids,
        isPaidView
          ? `${ids.length} ${ids.length === 1 ? 'payment' : 'payments'} sent back to the pay processor`
          : `${ids.length} ${ids.length === 1 ? 'record' : 'records'} cleared`,
      );
      setSelectedIds(new Set());
    } catch {
      /* toast already shown; selection kept so the user can retry */
    } finally {
      setBulkBusy(false);
    }
  }, [selectedIds, bulkBusy, undoIds, isPaidView]);

  const exportCsv = () => {
    if (filtered.length === 0) return;
    // Exports exactly what the filters show, department column included.
    const csv = sentRowsToCsv(buildSentRows(filtered, deptByEmail));
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
          <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold', ui.pill)}>
            <ui.Icon className="h-3 w-3" />
            {filtered.length} {filtered.length === 1 ? ui.noun : `${ui.noun}s`} {ui.verbed}
          </span>

          {/* Bulk undo — appears once at least one row is ticked. */}
          {selectedCount > 0 && (
            <div className="inline-flex items-center gap-1.5">
              <button
                type="button"
                onClick={undoSelected}
                disabled={bulkBusy}
                title={
                  isPaidView
                    ? 'Undo every selected payment and send them back to the pay processor as pending'
                    : statusFilter === 'problem'
                      ? 'Clear the selected problems — those people go back into the pending queue'
                      : 'Clear the selected records — they stay payable in the pending queue'
                }
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

          {/* Department filter — the same control the Pending worksheet uses, so
              the log views narrow to one team the same way. Hidden when there is
              only the "All departments" entry (nothing to choose between). */}
          {deptOptions.length > 1 && (
            <SmoothSelect
              aria-label="Filter by department"
              value={deptFilter}
              onChange={setDeptFilter}
              triggerClassName="h-8 w-[13rem] text-[11px]"
              searchable={deptOptions.length > 8}
              searchPlaceholder="Search departments…"
              options={deptOptions}
            />
          )}

          <div className="relative ml-auto w-full max-w-[260px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, email, txn, dept, who paid"
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
                <ui.Icon className="h-5 w-5" />
              </div>
              <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {paid.length === 0 ? emptyTitle : 'No matches'}
              </h2>
              <p className="mt-1 text-xs text-[#71717a] dark:text-zinc-500">
                {paid.length === 0
                  ? emptyHint
                  : deptFilter
                    ? 'Try a different search, or another department.'
                    : 'Try a different search.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-[#ececec] bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <table
              className={cn('w-full text-xs', showFromBankColumn ? 'min-w-[1780px]' : 'min-w-[1640px]')}
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
                  {/* Same order as the Pending queue's worksheet: Recipient → the
                      three currencies → System Bonus → From/To bank → TXN ID →
                      Department → the rest. */}
                  <th className="px-4 py-2.5 text-left font-medium">Recipient</th>
                  <th className="px-4 py-2.5 text-right font-medium">USD Value</th>
                  <th className="px-4 py-2.5 text-right font-medium">PHP Value</th>
                  <th className="px-4 py-2.5 text-right font-medium">COP Value</th>
                  <th className="px-4 py-2.5 text-right font-medium">System Bonus</th>
                  {showFromBankColumn && (
                    <th className="px-4 py-2.5 text-left font-medium">From Bank</th>
                  )}
                  <th className="px-4 py-2.5 text-left font-medium">To Recipient Bank</th>
                  <th className="px-4 py-2.5 text-left font-medium">TXN ID</th>
                  <th className="px-4 py-2.5 text-left font-medium">Department</th>
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
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium text-zinc-900 dark:text-zinc-100">
                            {rec.recipient_name ?? rec.recipient_email}
                          </span>
                          {/* Read off the DB row, so the badge survives into Done,
                              every per-processor paid sub-view and history. */}
                          {rec.payee_type === 'contractor' && <ContractorChip />}
                        </div>
                        <div className="font-mono text-[10px] text-[#71717a] dark:text-zinc-500">
                          {rec.recipient_email}
                        </div>
                      </td>
                      {/* One column per currency, matching the Pending worksheet. The
                          USD anchor is the strong figure on every row; a COP-only
                          record (no USD recorded) promotes COP instead, so exactly one
                          number per row reads as the headline. */}
                      <td
                        className={cn(
                          'px-4 py-2.5 text-right font-mono tabular-nums',
                          rec.amount_usd == null
                            ? 'text-zinc-400'
                            : 'font-semibold text-zinc-900 dark:text-zinc-100',
                        )}
                      >
                        {formatUSD(rec.amount_usd)}
                      </td>
                      <td
                        className={cn(
                          'px-4 py-2.5 text-right font-mono tabular-nums',
                          rec.amount_php == null ? 'text-zinc-400' : 'text-zinc-600 dark:text-zinc-400',
                        )}
                      >
                        {formatPHP(rec.amount_php)}
                      </td>
                      <td
                        className={cn(
                          'px-4 py-2.5 text-right font-mono tabular-nums',
                          rec.amount_cop == null
                            ? 'text-zinc-400'
                            : rec.amount_usd == null
                              ? 'font-semibold text-zinc-900 dark:text-zinc-100'
                              : 'text-zinc-600 dark:text-zinc-400',
                        )}
                      >
                        {formatCOP(rec.amount_cop)}
                      </td>
                      {/* Payment Catalog system bonus (PAB / Tech) snapshotted at Mark
                          Paid — its own column, not a chip under PHP, so it reads at a
                          glance across the whole page instead of only on hover. Rows
                          paid before add_system_bonus_to_payment_dispatches.sql have
                          neither field and render the dash. */}
                      <td className="px-4 py-2.5 text-right">
                        {rec.system_bonus_php != null && rec.system_bonus_php > 0 ? (
                          <SystemBonusCell amount={rec.system_bonus_php} label={rec.system_bonus_label} />
                        ) : (
                          <span className="font-mono text-[11px] text-zinc-300 dark:text-zinc-600">—</span>
                        )}
                      </td>
                      {showFromBankColumn && (
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-zinc-700 dark:text-zinc-300">
                            {meta?.label ?? rec.processor}
                          </div>
                          {/* The account the money actually left, as keyed at Mark Paid. */}
                          {rec.bank_used?.trim() && (
                            <div className="mt-0.5 truncate font-mono text-[10px] text-[#71717a] dark:text-zinc-500" title={`Sent from: ${rec.bank_used}`}>
                              {rec.bank_used}
                            </div>
                          )}
                        </td>
                      )}
                      <td className="max-w-[190px] px-4 py-2.5">
                        <RecordRecipientBank rec={rec} />
                      </td>
                      <td className="px-4 py-2.5">
                        {rec.transaction_id?.trim() ? (
                          <button
                            type="button"
                            onClick={() => copyText(rec.transaction_id.trim())}
                            title={`${rec.transaction_id.trim()} — click to copy`}
                            className="max-w-[150px] truncate text-left font-mono text-[11px] text-zinc-700 transition-colors hover:text-orange-700 dark:text-zinc-300 dark:hover:text-orange-300"
                          >
                            {rec.transaction_id.trim()}
                          </button>
                        ) : (
                          <span className="font-mono text-[11px] text-zinc-400">—</span>
                        )}
                      </td>
                      {/* Resolved for the cycle, not frozen on the record (there is no
                          department column on payment_dispatches) — so a payee no
                          source could place reads as a dash and still shows up under
                          the filter's "No department". */}
                      <td className="max-w-[150px] px-4 py-2.5">
                        {deptOf(rec) ? (
                          <DeptChip name={deptOf(rec)} />
                        ) : (
                          <span className="font-mono text-[11px] text-zinc-400">—</span>
                        )}
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
                        <div className="flex items-center justify-end gap-1.5">
                          {/* Contractor settlements pay an invoice, not a pay stub —
                              they have no rates row and no staged statement, so the
                              viewer could only ever say "not available". Same rule as
                              the pending queue's View. */}
                          {rec.payee_type !== 'contractor' && rec.cycle_source_file && (
                            <button
                              type="button"
                              onClick={() =>
                                setViewStub({
                                  sourceFile: rec.cycle_source_file as string,
                                  email: rec.recipient_email,
                                })
                              }
                              title="View the pay stub this dispatch settled"
                              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 text-[11px] font-medium text-zinc-600 transition-colors hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-orange-300"
                            >
                              <Receipt className="h-3 w-3" />
                              View
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => sendBackOne(rec)}
                            disabled={busy || bulkBusy}
                            title={
                              isPaidView
                                ? 'Undo this payment and send it back to the pay processor'
                                : statusFilter === 'problem'
                                  ? 'Clear this problem — the person goes back into the pending queue'
                                  : 'Clear this record — the person stays payable in the pending queue'
                            }
                            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-amber-200 bg-white px-2.5 text-[11px] font-medium text-amber-700 transition-colors hover:border-amber-300 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-500/30 dark:bg-zinc-950 dark:text-amber-300 dark:hover:bg-amber-500/10"
                          >
                            {busy ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Undo2 className="h-3 w-3" />
                            )}
                            {isPaidView ? 'Undo' : 'Clear'}
                          </button>
                        </div>
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

      <PayStubModal
        open={viewStub != null}
        sourceFile={viewStub?.sourceFile ?? null}
        email={viewStub?.email ?? null}
        onClose={() => setViewStub(null)}
      />
    </div>
  );
}
