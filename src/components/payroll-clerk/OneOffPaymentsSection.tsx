'use client';

/**
 * One-off payments INSIDE the processor buckets (Kane 2026-09-01) — the cards
 * that used to live under Payment Dispatch → Urgent → "One-off Payments".
 *
 * A one-off filed from the People tab (roster or Offboarded search) now renders
 * in the bucket of the recipient's SERVER-resolved payout rail — mixed with the
 * weekly queue visually, never structurally:
 *
 *   - Pending one-off cards are this section, mounted above the pending table
 *     via ProcessorQueue's `renderExtras`. They are NOT QueueRows: merging them
 *     into `rows` would leak them into the pending CSV export, whose identity
 *     tests (Regular+OT + Bonus Total + … = Amount) have no meaning for a
 *     one-off.
 *   - The DISPATCH RECORD is unchanged: Send still posts
 *     /api/urgent-payments/requests/[id]/dispatch, which writes cycle_id=NULL +
 *     cycle_source_file=urgent_<week>. Writing the weekly cycle's file instead
 *     would corrupt close-out tallies, the export identity tests, and the
 *     paystub week-dedupe — placement is UI-only.
 *   - Dispatched one-offs (this Sun→Sat week, `is_one_off` from
 *     /api/urgent-payments/dispatches) render as their own strip above the
 *     bucket's log views. They are deliberately NOT injected into
 *     PaidRecordsPanel: its Undo deletes the payment_dispatches row directly,
 *     which for a one-off strands the source request as dispatched-forever —
 *     one-off undo must go through /api/urgent-payments/dispatches/undo
 *     (revive-before-delete). See docs/features/urgent-payments.md.
 *
 * Bucket membership derives from the SERVER-resolved processor, not the
 * per-card override — changing the select must not teleport the card to
 * another tab mid-action; the override still drives what Send records.
 * Unrouted rows (no rail on file) appear under "All pending" only, flagged
 * "No bank — set bank details" (an unrouted person is never payable; the
 * People → Offboarded tab is where the bank gets set).
 *
 * MESA disbursements and orphanage budget requests stay under Urgent.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock, Loader2, RefreshCw, RotateCcw, Send, Trash2, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import MarkPaidDialog, { type MarkPaidPayload } from './MarkPaidDialog';
import { PROCESSORS, DISPATCH_PROCESSORS, type ProcessorId, type QueueRow } from './mock-queue';
import type { PaymentDispatchRow, PaymentDispatchStatus } from '@/lib/supabase/payment-dispatches';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';

/** A one-off payment filed from the People tab "Pay" action. */
export interface UrgentOneOffRow {
  id: string;
  work_email: string;
  full_name: string;
  department: string | null;
  amount_php: number | null;
  /** USD equivalent of `amount_php`, converted server-side at the active FX rate. */
  amount_usd: number | null;
  note: string | null;
  requested_by: string | null;
  requested_at: string;
  /** The rail Payment Dispatch would pay this person on (server-resolved with
   *  PD's full precedence); null when none resolves. */
  processor: ProcessorId | null;
  /** Per-processor payout detail so Mark Paid pre-fills for the chosen processor. */
  details: QueueRow['details'];
}

/** A dispatch-log row from /api/urgent-payments/dispatches (+ is_one_off). */
type OneOffDispatchRow = PaymentDispatchRow & { is_one_off?: boolean };

const PROCESSOR_LABEL: Record<ProcessorId, string> = PROCESSORS.reduce(
  (acc, p) => { acc[p.id] = p.label; return acc; },
  {} as Record<ProcessorId, string>,
);

function formatPHP(v: number | null | undefined) {
  if (v == null) return '—';
  return v.toLocaleString('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: 2 });
}

function formatUSD(v: number | null | undefined) {
  if (v == null) return '—';
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Render a date-only string (YYYY-MM-DD…) without timezone drift. */
function formatDateOnly(iso: string | null | undefined): string | null {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// Build a QueueRow compatible with MarkPaidDialog from a one-off payment
// request (moved verbatim from UrgentPaymentsQueue). A one-off is not a payroll
// row: no bonus/orphanage/MESA split, no wizard carrier, no department key.
function toQueueRowOneOff(r: UrgentOneOffRow, processor: ProcessorId): QueueRow {
  return {
    id: r.id,
    processor,
    name: r.full_name,
    email: r.work_email,
    amountUSD: r.amount_usd,
    amountPHP: r.amount_php,
    amountCOP: null,
    payCurrency: 'PHP',
    initialPayUSD: r.amount_usd,
    initialPayPHP: r.amount_php,
    pabBonusPHP: 0,
    techBonusPHP: 0,
    otherBonusesPHP: 0,
    adjustmentPHP: 0,
    bonusTotalPHP: 0,
    orphanagePayPHP: 0,
    mesaDeductionPHP: 0,
    mesaDisbursementPHP: 0,
    totalHours: null,
    otHours: null,
    bankPreferredRaw: PROCESSOR_LABEL[processor] ?? null,
    departmentKey: null,
    departmentName: null,
    details: r.details ?? { email: r.work_email },
  };
}

const STATUS_BADGE: Record<PaymentDispatchStatus, string> = {
  paid: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-700/40 dark:bg-emerald-950/30 dark:text-emerald-300',
  not_paid: 'border-zinc-200 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300',
  threshold: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-700/40 dark:bg-amber-950/30 dark:text-amber-300',
  problem: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-700/40 dark:bg-rose-950/30 dark:text-rose-300',
};

function AmountBlock({ php, usd }: { php: number | null; usd: number | null }) {
  return (
    <div className="text-right">
      <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Amount</div>
      {php == null ? (
        <div className="text-sm text-zinc-400">—</div>
      ) : usd == null ? (
        <div className="font-mono text-lg font-bold tabular-nums text-zinc-900 dark:text-zinc-100">{formatPHP(php)}</div>
      ) : (
        <>
          <div className="font-mono text-lg font-bold tabular-nums text-zinc-900 dark:text-zinc-100">{formatUSD(usd)}</div>
          <div className="font-mono text-[11px] font-medium tabular-nums text-zinc-500 dark:text-zinc-400">{formatPHP(php)}</div>
        </>
      )}
    </div>
  );
}

/** "One-off" identity chip — every card in this section wears it so a one-off
 *  is never mistaken for a weekly payroll row in the same bucket. */
function OneOffChip() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-violet-700 dark:border-violet-700/40 dark:bg-violet-950/30 dark:text-violet-300">
      <Wallet className="h-3 w-3" /> One-off
    </span>
  );
}

function PendingOneOffCard({
  row,
  processor,
  onProcessorChange,
  onSend,
  onRemove,
}: {
  row: UrgentOneOffRow;
  processor: ProcessorId | null;
  onProcessorChange: (p: ProcessorId) => void;
  onSend: () => void;
  onRemove: () => void;
}) {
  const requestedDate = new Date(row.requested_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-violet-200/70 bg-white p-4 shadow-sm transition-shadow hover:shadow-md sm:flex-row sm:items-center sm:gap-4 dark:border-violet-800/30 dark:bg-zinc-900/60">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-50 text-violet-600 ring-1 ring-violet-100 dark:bg-violet-950/30 dark:text-violet-300 dark:ring-violet-900/40">
        <Wallet className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">{row.full_name}</span>
          <OneOffChip />
          {row.department && (
            <span className="text-xs text-zinc-400 dark:text-zinc-500" title={row.department}>
              {formatDeptLabel(row.department)}
            </span>
          )}
          {!row.processor && (
            <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:border-amber-700/40 dark:bg-amber-950/30 dark:text-amber-300">
              No bank — set bank details
            </span>
          )}
        </div>
        <div className="font-mono text-[11px] text-zinc-500 dark:text-zinc-500">{row.work_email}</div>
        {row.note && <p className="line-clamp-1 pt-1 text-[11px] text-zinc-500 dark:text-zinc-400">{row.note}</p>}
        <div className="flex flex-wrap gap-3 pt-1">
          <span className="flex items-center gap-1 text-[11px] text-zinc-400 dark:text-zinc-500">
            <Clock className="h-3 w-3" />
            Requested {requestedDate}
            {row.requested_by && <span className="text-zinc-400 dark:text-zinc-500">by {row.requested_by.split('@')[0]}</span>}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-3 sm:flex-col sm:items-end sm:gap-2">
        <AmountBlock php={row.amount_php} usd={row.amount_usd} />
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor={`oneoff-proc-${row.id}`}>Payment processor</label>
          <select
            id={`oneoff-proc-${row.id}`}
            value={processor ?? ''}
            onChange={(e) => onProcessorChange(e.target.value as ProcessorId)}
            className="h-8 rounded-md border border-violet-200 bg-violet-50/60 px-2 text-[12px] font-medium text-violet-800 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-200 dark:border-violet-800/40 dark:bg-violet-950/20 dark:text-violet-200"
            title="Choose which processor to pay through"
          >
            {!processor && <option value="" disabled>No rail on file — choose one</option>}
            {DISPATCH_PROCESSORS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
          <Button
            type="button"
            size="sm"
            onClick={onSend}
            disabled={!processor}
            title={processor ? undefined : 'Choose a payment rail first — this recipient has none on file.'}
            className="gap-1.5 bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 dark:bg-violet-600 dark:hover:bg-violet-500"
          >
            <Send className="h-3.5 w-3.5" />
            Send
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRemove}
            aria-label="Delete this payment"
            title="Delete this payment"
            className="h-8 w-8 shrink-0 border-zinc-200 p-0 text-zinc-400 transition-colors hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:border-zinc-700 dark:text-zinc-500 dark:hover:border-rose-800/60 dark:hover:bg-rose-950/30 dark:hover:text-rose-400"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function DispatchedOneOffCard({ row, onUndo }: { row: OneOffDispatchRow; onUndo: () => void }) {
  const sentDate = formatDateOnly(row.sent_date);
  const processorLabel = PROCESSOR_LABEL[row.processor as ProcessorId] ?? row.processor;
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-violet-200/70 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:gap-4 dark:border-violet-800/30 dark:bg-zinc-900/60">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">{row.recipient_name ?? row.recipient_email}</span>
          <OneOffChip />
          <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider', STATUS_BADGE[row.status])}>
            {row.status.replace('_', ' ')}
          </span>
        </div>
        <div className="font-mono text-[11px] text-zinc-500 dark:text-zinc-500">{row.recipient_email}</div>
        <div className="flex flex-wrap gap-3 pt-1">
          {sentDate && (
            <span className="flex items-center gap-1 text-[11px] text-zinc-400 dark:text-zinc-500">
              <Clock className="h-3 w-3" /> Sent {sentDate}
            </span>
          )}
          {row.transaction_id && (
            <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500">#{row.transaction_id}</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 sm:flex-col sm:items-end sm:gap-2">
        <AmountBlock php={row.amount_php} usd={row.amount_usd} />
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-800 dark:border-violet-800/40 dark:bg-violet-950/20 dark:text-violet-200">
            {processorLabel}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onUndo}
            title="Undo — send back to the pending queue"
            className="h-8 gap-1.5 border-zinc-200 px-2.5 text-xs text-zinc-600 transition-colors hover:border-amber-300 hover:bg-amber-50 hover:text-amber-700 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-amber-700/50 dark:hover:bg-amber-950/30 dark:hover:text-amber-300"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Undo
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function OneOffPaymentsSection({
  processor,
  view,
}: {
  /** Which bucket this section is mounted in: a rail id, or null for
   *  "All pending" (which also shows the unrouted rows). */
  processor: ProcessorId | null;
  /** The host queue's active sub-view — pending shows the payable cards, the
   *  log views show this week's dispatched one-offs with the matching status. */
  view: 'pending' | PaymentDispatchStatus;
}) {
  const [rows, setRows] = useState<UrgentOneOffRow[]>([]);
  const [dispatched, setDispatched] = useState<OneOffDispatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Per-card processor override — drives what Send records, never bucket
  // membership (see module doc).
  const [processorByRow, setProcessorByRow] = useState<Record<string, ProcessorId>>({});
  const [markRow, setMarkRow] = useState<UrgentOneOffRow | null>(null);
  const [removeTarget, setRemoveTarget] = useState<UrgentOneOffRow | null>(null);
  const [removing, setRemoving] = useState(false);
  const [undoTarget, setUndoTarget] = useState<OneOffDispatchRow | null>(null);
  const [undoing, setUndoing] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); else setRefreshing(true);
    try {
      const [pendingRes, dispatchedRes] = await Promise.all([
        fetch('/api/urgent-payments/requests', { cache: 'no-store' }),
        fetch('/api/urgent-payments/dispatches', { cache: 'no-store' }),
      ]);
      const pendingJson = (await pendingRes.json()) as { rows?: UrgentOneOffRow[]; error?: string };
      if (!pendingRes.ok || pendingJson.error) throw new Error(pendingJson.error || `HTTP ${pendingRes.status}`);
      setRows(pendingJson.rows ?? []);
      // Dispatch log is best-effort: a failure keeps the last strip rather than
      // blanking it — the pending cards are the part that must not lie.
      try {
        const dispatchedJson = (await dispatchedRes.json()) as { rows?: OneOffDispatchRow[]; error?: string };
        if (dispatchedRes.ok && !dispatchedJson.error) {
          setDispatched((dispatchedJson.rows ?? []).filter((r) => r.is_one_off === true));
        }
      } catch { /* keep last */ }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load one-off payments');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const processorFor = useCallback(
    (r: UrgentOneOffRow): ProcessorId | null => processorByRow[r.id] ?? r.processor ?? null,
    [processorByRow],
  );

  // Bucket membership: SERVER-resolved rail only. Unrouted rows live in "All".
  const pendingVisible = useMemo(
    () => (processor === null ? rows : rows.filter((r) => r.processor === processor)),
    [rows, processor],
  );
  const dispatchedVisible = useMemo(
    () =>
      view === 'pending'
        ? []
        : dispatched.filter(
            (r) => r.status === view && (processor === null || r.processor === processor),
          ),
    [dispatched, view, processor],
  );

  const handleConfirm = async (payload: MarkPaidPayload) => {
    const target = rows.find((r) => r.id === payload.rowId);
    if (!target) return;
    const proc = processorFor(target);
    if (!proc) {
      toast.error(`${target.full_name} has no payment rail on file — pick one before sending.`);
      return;
    }
    // Optimistic removal, rolled back on failure (mirrors the Urgent queue).
    setRows((prev) => prev.filter((r) => r.id !== payload.rowId));
    setMarkRow(null);
    try {
      const res = await fetch(`/api/urgent-payments/requests/${payload.rowId}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient_email: target.work_email,
          recipient_name: target.full_name,
          amount_php: target.amount_php,
          processor: proc,
          transaction_id: payload.transactionId,
          bank_used: payload.bankUsed,
          sent_date: payload.sentDate,
          arrival_date: payload.arrivalDate || null,
          recipient_preferred_bank: payload.recipientPreferredBank || null,
          recipient_account_number: payload.recipientAccountNumber || null,
          recipient_account_holder: payload.recipientAccountHolder || null,
          recipient_swift_code: payload.recipientSwiftCode || null,
          status: payload.status,
          note: payload.note || null,
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Dispatch failed');
      toast.success(`${target.full_name} — payment sent via ${PROCESSOR_LABEL[proc]}`);
      void load(true);
    } catch (e) {
      setRows((prev) => (prev.some((r) => r.id === target.id) ? prev : [target, ...prev]));
      toast.error(e instanceof Error ? e.message : 'Dispatch failed');
    }
  };

  // Awaits the server before dropping the card — a failed removal must leave
  // the payment plainly still there. Cancels (status flip), never deletes.
  const handleRemove = async () => {
    if (!removeTarget || removing) return;
    const target = removeTarget;
    setRemoving(true);
    try {
      const res = await fetch(`/api/urgent-payments/requests/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Could not remove this payment');
      setRows((prev) => prev.filter((r) => r.id !== target.id));
      setRemoveTarget(null);
      toast.success(`Removed — ${target.full_name} will not be paid from this queue.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove this payment');
    } finally {
      setRemoving(false);
    }
  };

  // One-off undo MUST use the urgent undo route (revive-before-delete) — the
  // regular /api/payment-dispatches/undo would delete the money log and strand
  // the request stamped dispatched-forever.
  const handleUndo = async () => {
    if (!undoTarget || undoing) return;
    const target = undoTarget;
    setUndoing(true);
    try {
      const res = await fetch('/api/urgent-payments/dispatches/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: target.id }),
      });
      const json = (await res.json().catch(() => ({}))) as { warning?: string | null; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Could not undo this payment');
      setUndoTarget(null);
      const name = target.recipient_name ?? target.recipient_email;
      if (json.warning) toast.warning(`${name} — ${json.warning}`);
      else toast.success(`Undone — ${name} is back in the pending queue.`);
      void load(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not undo this payment');
    } finally {
      setUndoing(false);
    }
  };

  // Stable QueueRow for MarkPaidDialog (an inline literal would wipe the
  // clerk's typed fields on any parent re-render — see UrgentPaymentsQueue).
  const markRowQueue = useMemo(() => {
    if (!markRow) return null;
    const p = processorFor(markRow);
    return p ? toQueueRowOneOff(markRow, p) : null;
  }, [markRow, processorFor]);

  const visible = view === 'pending' ? pendingVisible.length : dispatchedVisible.length;
  if (!loading && visible === 0) return null;

  return (
    <section className="space-y-3 px-4 pt-4 sm:px-6">
      <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
        <Wallet className="h-3.5 w-3.5 text-violet-500" />
        One-off Payments
        <span className="ml-1 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold text-violet-700 dark:bg-violet-950/60 dark:text-violet-300">
          {visible}
        </span>
        <button
          type="button"
          onClick={() => void load(true)}
          title="Refresh one-off payments"
          aria-label="Refresh one-off payments"
          className="ml-1 rounded p-0.5 text-zinc-400 transition-colors hover:text-violet-600 dark:hover:text-violet-300"
        >
          <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} />
        </button>
      </h3>

      {loading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-zinc-100 bg-white p-4 text-[12px] text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900/60">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading one-off payments…
        </div>
      ) : view === 'pending' ? (
        <div className="space-y-3">
          {pendingVisible.map((r) => (
            <PendingOneOffCard
              key={r.id}
              row={r}
              processor={processorFor(r)}
              onProcessorChange={(p) => setProcessorByRow((prev) => ({ ...prev, [r.id]: p }))}
              onSend={() => setMarkRow(r)}
              onRemove={() => setRemoveTarget(r)}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {dispatchedVisible.map((r) => (
            <DispatchedOneOffCard key={r.id} row={r} onUndo={() => setUndoTarget(r)} />
          ))}
        </div>
      )}

      <MarkPaidDialog row={markRowQueue} onClose={() => setMarkRow(null)} onConfirm={handleConfirm} />

      {/* Remove confirmation — money-adjacent, so never a one-click delete. */}
      <Dialog open={removeTarget != null} onOpenChange={(o) => { if (!o && !removing) setRemoveTarget(null); }}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-400">
              <Trash2 className="h-4 w-4" />
            </span>
            Delete payment?
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed">
            {removeTarget && (
              <>
                <span className="font-semibold text-zinc-900 dark:text-zinc-100">{removeTarget.full_name}</span>
                {removeTarget.amount_php != null && (
                  <>
                    {' — '}
                    <span className="font-mono font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                      {formatPHP(removeTarget.amount_php)}
                    </span>
                  </>
                )}
                . This cancels the one-off payment request — nothing is paid, and it leaves this queue for good.
              </>
            )}
          </DialogDescription>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={removing} onClick={() => setRemoveTarget(null)}>
              Keep it
            </Button>
            <Button
              type="button"
              disabled={removing}
              onClick={() => void handleRemove()}
              className="gap-1.5 bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-600 dark:hover:bg-rose-500"
            >
              {removing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Undo confirmation — money-adjacent, so never a one-click action. */}
      <Dialog open={undoTarget != null} onOpenChange={(o) => { if (!o && !undoing) setUndoTarget(null); }}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400">
              <RotateCcw className="h-4 w-4" />
            </span>
            Undo this payment?
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed">
            {undoTarget && (
              <>
                <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                  {undoTarget.recipient_name ?? undoTarget.recipient_email}
                </span>
                {undoTarget.amount_php != null && (
                  <>
                    {' — '}
                    <span className="font-mono font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                      {formatPHP(undoTarget.amount_php)}
                    </span>
                  </>
                )}
                . This deletes the logged payment and returns the request to pending. It does NOT reverse money already sent.
              </>
            )}
          </DialogDescription>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={undoing} onClick={() => setUndoTarget(null)}>
              Keep it
            </Button>
            <Button
              type="button"
              disabled={undoing}
              onClick={() => void handleUndo()}
              className="gap-1.5 bg-amber-500 text-white hover:bg-amber-600 dark:bg-amber-600 dark:hover:bg-amber-500"
            >
              {undoing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
              Undo payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
