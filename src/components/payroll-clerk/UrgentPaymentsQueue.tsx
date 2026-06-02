'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  HeartHandshake,
  Inbox,
  RefreshCw,
  Send,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import MarkPaidDialog, { type MarkPaidPayload } from './MarkPaidDialog';
import type { QueueRow } from './mock-queue';

export interface UrgentPaymentRow {
  id: string;
  work_email: string;
  full_name: string;
  department: string;
  disbursement_reason: string | null;
  explanation: string | null;
  amount_needed: number | null;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  wise_email: string | null;
  wise_tag: string | null;
  account_holder_name: string | null;
  phone_number: string | null;
}

interface Props {
  /** Called whenever the count of pending urgent items changes. */
  onCountChange?: (n: number) => void;
}

// Build a minimal QueueRow compatible with MarkPaidDialog from a MESA request.
function toQueueRow(r: UrgentPaymentRow): QueueRow {
  return {
    id: r.id,
    processor: 'wise',
    name: r.full_name,
    email: r.work_email,
    amountUSD: null,
    amountPHP: r.amount_needed,
    initialPayUSD: null,
    initialPayPHP: r.amount_needed,
    pabBonusPHP: 0,
    techBonusPHP: 0,
    bonusTotalPHP: 0,
    totalHours: null,
    otHours: null,
    bankPreferredRaw: 'Wise',
    details: {
      wise_email: r.wise_email ?? undefined,
      wise_tag: r.wise_tag ?? undefined,
      account_holder_name: r.account_holder_name ?? undefined,
      phone_number: r.phone_number ?? undefined,
      email: r.work_email,
    },
  };
}

export default function UrgentPaymentsQueue({ onCountChange }: Props) {
  const [rows, setRows] = useState<UrgentPaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [markRow, setMarkRow] = useState<UrgentPaymentRow | null>(null);
  const [dispatching, setDispatching] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); else setRefreshing(true);
    try {
      const res = await fetch('/api/urgent-payments', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { rows?: UrgentPaymentRow[]; error?: string };
      if (json.error) throw new Error(json.error);
      const data = json.rows ?? [];
      setRows(data);
      onCountChange?.(data.length);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load urgent payments');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [onCountChange]);

  useEffect(() => { void load(); }, [load]);

  const handleRefresh = async () => {
    await load(true);
    toast.success('Refreshed urgent payments');
  };

  const handleConfirm = async (payload: MarkPaidPayload) => {
    const target = rows.find((r) => r.id === payload.rowId);
    if (!target) return;

    setDispatching(true);
    // Optimistically remove from list
    setRows((prev) => prev.filter((r) => r.id !== payload.rowId));
    onCountChange?.(rows.length - 1);
    setMarkRow(null);

    try {
      const res = await fetch(`/api/mesa-requests/${payload.rowId}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient_email: target.work_email,
          recipient_name: target.full_name,
          amount_php: target.amount_needed,
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
      toast.success(`${target.full_name} — MESA disbursement sent`);
      void load(true);
    } catch (e) {
      // Rollback optimistic removal
      setRows((prev) => [target, ...prev]);
      onCountChange?.(rows.length);
      toast.error(e instanceof Error ? e.message : 'Dispatch failed');
    } finally {
      setDispatching(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-gradient-to-br from-white via-amber-50/30 to-orange-50/20 p-4 sm:p-6 dark:bg-none dark:bg-[#0d1117]">
      <div className="mx-auto w-full max-w-5xl space-y-5">

        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-100 to-orange-100 text-amber-700 ring-1 ring-amber-100 dark:from-amber-950/60 dark:to-orange-950/40 dark:text-amber-300 dark:ring-amber-900/60">
              <Zap className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700 dark:text-amber-300">
                Payment Dispatch
              </p>
              <h2 className="mt-0.5 text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">
                Urgent Payments
              </h2>
              <p className="mt-1 max-w-xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                Approved MESA disbursements awaiting immediate payout via Wise. These bypass the weekly payroll cycle.
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing || loading}
            className="shrink-0 gap-1.5"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            Refresh
          </Button>
        </div>

        {/* Body */}
        {loading ? (
          <SkeletonRows />
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-amber-100 bg-white px-6 py-16 text-center shadow-sm dark:border-amber-900/30 dark:bg-zinc-900/40">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-500 dark:bg-emerald-950/30 dark:text-emerald-400">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <div>
              <p className="font-semibold text-zinc-900 dark:text-white">All clear</p>
              <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
                No approved MESA disbursements pending dispatch.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {rows.map((r) => (
              <UrgentCard key={r.id} row={r} onSend={() => setMarkRow(r)} />
            ))}
          </div>
        )}
      </div>

      <MarkPaidDialog
        row={markRow ? toQueueRow(markRow) : null}
        onClose={() => setMarkRow(null)}
        onConfirm={handleConfirm}
      />
    </div>
  );
}

function UrgentCard({ row, onSend }: { row: UrgentPaymentRow; onSend: () => void }) {
  const approvedDate = row.reviewed_at
    ? new Date(row.reviewed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null;
  const submittedDate = new Date(row.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-amber-200/70 bg-white p-4 shadow-sm transition-shadow hover:shadow-md sm:flex-row sm:items-center sm:gap-4 dark:border-amber-800/30 dark:bg-zinc-900/60">
      {/* Icon */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600 ring-1 ring-amber-100 dark:bg-amber-950/30 dark:text-amber-300 dark:ring-amber-900/40">
        <HeartHandshake className="h-5 w-5" />
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">{row.full_name}</span>
          <span className="text-xs text-zinc-400 dark:text-zinc-500">{row.department}</span>
        </div>
        <div className="font-mono text-[11px] text-zinc-500 dark:text-zinc-500">{row.work_email}</div>
        {row.disbursement_reason && (
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <Badge variant="outline" className="border-amber-200 bg-amber-50 text-[10.5px] text-amber-700 dark:border-amber-700/40 dark:bg-amber-950/30 dark:text-amber-300">
              {row.disbursement_reason}
            </Badge>
            {row.explanation && (
              <span className="line-clamp-1 text-[11px] text-zinc-500 dark:text-zinc-400">{row.explanation}</span>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-3 pt-1">
          <span className="flex items-center gap-1 text-[11px] text-zinc-400 dark:text-zinc-500">
            <Clock className="h-3 w-3" />
            Submitted {submittedDate}
          </span>
          {approvedDate && (
            <span className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3 w-3" />
              Approved {approvedDate}
              {row.reviewed_by && <span className="text-zinc-400 dark:text-zinc-500">by {row.reviewed_by.split('@')[0]}</span>}
            </span>
          )}
        </div>
      </div>

      {/* Amount + action */}
      <div className="flex items-center gap-3 sm:flex-col sm:items-end sm:gap-2">
        <div className="text-right">
          <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Amount</div>
          {row.amount_needed != null ? (
            <div className="font-mono text-lg font-bold tabular-nums text-zinc-900 dark:text-zinc-100">
              {row.amount_needed.toLocaleString('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: 2 })}
            </div>
          ) : (
            <div className="text-sm text-zinc-400">—</div>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          onClick={onSend}
          className="gap-1.5 bg-amber-500 text-white hover:bg-amber-600 dark:bg-amber-600 dark:hover:bg-amber-500"
        >
          <Send className="h-3.5 w-3.5" />
          Send via Wise
        </Button>
      </div>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-4 rounded-2xl border border-zinc-100 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/60">
          <div className="h-10 w-10 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-40 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
            <div className="h-3 w-28 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
          </div>
          <div className="h-8 w-28 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" />
        </div>
      ))}
    </div>
  );
}
