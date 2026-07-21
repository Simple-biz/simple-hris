'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from 'next-auth/react';
import {
  Banknote,
  Building2,
  CheckCircle2,
  Clock,
  HeartHandshake,
  RefreshCw,
  Send,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import MarkPaidDialog, { type MarkPaidPayload } from './MarkPaidDialog';
import OrphanageMarkPaidDialog, { type OrphanageMarkPaidPayload } from './OrphanageMarkPaidDialog';
import { PROCESSORS, DISPATCH_PROCESSORS, type ProcessorId, type QueueRow } from './mock-queue';
import type { OrphanagePendingItem } from '@/lib/supabase/orphanage-dispatches';

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
  /** Recipient's saved preferred processor (defaults to 'wise' for MESA). */
  processor: ProcessorId;
  /** Per-processor payout detail so Mark Paid pre-fills for the chosen processor. */
  details: QueueRow['details'];
}

interface Props {
  /** Called whenever the count of pending urgent items changes (MESA + budget). */
  onCountChange?: (n: number) => void;
}

const PROCESSOR_LABEL: Record<ProcessorId, string> = PROCESSORS.reduce(
  (acc, p) => { acc[p.id] = p.label; return acc; },
  {} as Record<ProcessorId, string>,
);

function formatPHP(v: number | null | undefined) {
  if (v == null) return '—';
  return v.toLocaleString('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: 2 });
}

// Build a QueueRow compatible with MarkPaidDialog from a MESA request + the
// processor the clerk picked for this payout.
function toQueueRow(r: UrgentPaymentRow, processor: ProcessorId): QueueRow {
  return {
    id: r.id,
    processor,
    name: r.full_name,
    email: r.work_email,
    amountUSD: null,
    amountPHP: r.amount_needed,
    amountCOP: null,
    payCurrency: 'PHP',
    initialPayUSD: null,
    initialPayPHP: r.amount_needed,
    pabBonusPHP: 0,
    techBonusPHP: 0,
    bonusTotalPHP: 0,
    totalHours: null,
    otHours: null,
    bankPreferredRaw: PROCESSOR_LABEL[processor] ?? null,
    // MESA urgent payments aren't tied to a payroll department.
    departmentKey: null,
    departmentName: null,
    details: r.details ?? { email: r.work_email },
  };
}

export default function UrgentPaymentsQueue({ onCountChange }: Props) {
  const { data: session } = useSession();
  const userEmail = session?.user?.email ?? null;

  const [rows, setRows] = useState<UrgentPaymentRow[]>([]);
  const [budgetItems, setBudgetItems] = useState<OrphanagePendingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [markRow, setMarkRow] = useState<UrgentPaymentRow | null>(null);
  const [markBudget, setMarkBudget] = useState<OrphanagePendingItem | null>(null);
  // Per-row processor override the clerk picks on each MESA card. Defaults to
  // the recipient's preferred processor returned by the API.
  const [processorByRow, setProcessorByRow] = useState<Record<string, ProcessorId>>({});
  // Top filter rail — narrow the MESA queue to one processor.
  const [filter, setFilter] = useState<ProcessorId | 'all'>('all');

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); else setRefreshing(true);
    try {
      const [mesaRes, orphRes] = await Promise.all([
        fetch('/api/urgent-payments', { cache: 'no-store' }),
        fetch('/api/orphanage-dispatches?pending=1', { cache: 'no-store' }),
      ]);
      if (!mesaRes.ok) throw new Error(`HTTP ${mesaRes.status}`);
      const mesaJson = (await mesaRes.json()) as { rows?: UrgentPaymentRow[]; error?: string };
      if (mesaJson.error) throw new Error(mesaJson.error);
      const mesa = mesaJson.rows ?? [];
      setRows(mesa);

      // Orphanage budget requests — best-effort: a failure here must not break
      // the MESA queue. Gift purchases are NOT urgent, so we filter to budgets.
      let budget: OrphanagePendingItem[] = [];
      try {
        const orphJson = (await orphRes.json()) as { items?: OrphanagePendingItem[]; error?: string };
        if (orphRes.ok && !orphJson.error) {
          budget = (orphJson.items ?? []).filter((i) => i.sourceType === 'budget_request');
        }
      } catch {
        /* ignore — budget section silently omitted */
      }
      setBudgetItems(budget);
      onCountChange?.(mesa.length + budget.length);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load urgent payments');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [onCountChange]);

  useEffect(() => { void load(); }, [load]);

  // Resolve the processor chosen for a given MESA row (override → preferred → wise).
  const processorFor = useCallback(
    (r: UrgentPaymentRow): ProcessorId => processorByRow[r.id] ?? r.processor ?? 'wise',
    [processorByRow],
  );

  const setProcessorFor = useCallback((rowId: string, processor: ProcessorId) => {
    setProcessorByRow((prev) => ({ ...prev, [rowId]: processor }));
  }, []);

  // Count MESA rows per processor (using the chosen processor) for the filter rail.
  const counts = useMemo(() => {
    const c: Partial<Record<ProcessorId, number>> = {};
    for (const r of rows) {
      const p = processorFor(r);
      c[p] = (c[p] ?? 0) + 1;
    }
    return c;
  }, [rows, processorFor]);

  const presentProcessors = useMemo(
    () => DISPATCH_PROCESSORS.filter((p) => (counts[p.id] ?? 0) > 0),
    [counts],
  );

  const visibleRows = useMemo(
    () => (filter === 'all' ? rows : rows.filter((r) => processorFor(r) === filter)),
    [rows, filter, processorFor],
  );

  const handleRefresh = async () => {
    await load(true);
    toast.success('Refreshed urgent payments');
  };

  const handleConfirm = async (payload: MarkPaidPayload) => {
    const target = rows.find((r) => r.id === payload.rowId);
    if (!target) return;
    const processor = processorFor(target);

    // Optimistically remove from list
    const nextRows = rows.filter((r) => r.id !== payload.rowId);
    setRows(nextRows);
    onCountChange?.(nextRows.length + budgetItems.length);
    setMarkRow(null);

    try {
      const res = await fetch(`/api/mesa-requests/${payload.rowId}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient_email: target.work_email,
          recipient_name: target.full_name,
          amount_php: target.amount_needed,
          processor,
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
      toast.success(`${target.full_name} — MESA disbursement sent via ${PROCESSOR_LABEL[processor]}`);
      void load(true);
    } catch (e) {
      // Rollback optimistic removal
      setRows((prev) => [target, ...prev]);
      onCountChange?.(rows.length + budgetItems.length);
      toast.error(e instanceof Error ? e.message : 'Dispatch failed');
    }
  };

  const handleConfirmBudget = async (item: OrphanagePendingItem, payload: OrphanageMarkPaidPayload) => {
    const res = await fetch('/api/orphanage-dispatches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_type: item.sourceType,
        source_id: item.sourceId,
        label: item.label,
        submitter_email: item.submitterEmail,
        bank_name: payload.bankName,
        bank_account_name: payload.bankAccountName,
        bank_account_number: payload.bankAccountNumber,
        swift_code: payload.swiftCode,
        amount_php: item.amountPhp,
        status: payload.status,
        transaction_id: payload.transactionId || null,
        bank_used: payload.bankUsed || null,
        sent_date: payload.sentDate || null,
        note: payload.note || null,
        paid_by: userEmail,
      }),
    });
    const json = (await res.json()) as { row?: unknown; error?: string };
    if (!res.ok || json.error) {
      toast.error(json.error ?? 'Could not log payment');
      return;
    }
    toast.success(
      payload.status === 'paid'
        ? `Orphanage budget paid — "${item.label}"`
        : `Problem logged — "${item.label}"`,
      { icon: payload.status === 'paid' ? '✅' : '⚠️' },
    );
    setMarkBudget(null);
    const nextBudget = budgetItems.filter((i) => i.sourceId !== item.sourceId);
    setBudgetItems(nextBudget);
    onCountChange?.(rows.length + nextBudget.length);
  };

  const hasAny = rows.length > 0 || budgetItems.length > 0;

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
                MESA disbursements and approved orphanage budget requests awaiting immediate payout.
                These bypass the weekly payroll cycle and reconcile in the weekly report.
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
        ) : !hasAny ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-amber-100 bg-white px-6 py-16 text-center shadow-sm dark:border-amber-900/30 dark:bg-zinc-900/40">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-500 dark:bg-emerald-950/30 dark:text-emerald-400">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <div>
              <p className="font-semibold text-zinc-900 dark:text-white">All clear</p>
              <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
                No approved MESA disbursements or orphanage budget requests pending dispatch.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {/* ── MESA disbursements ── */}
            {rows.length > 0 && (
              <section className="space-y-3">
                <SectionHeader Icon={HeartHandshake} title="MESA Disbursements" count={rows.length} />

                {/* Processor filter rail (MESA only) */}
                {presentProcessors.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="mr-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400 dark:text-zinc-500">
                      Processor
                    </span>
                    <FilterChip label="All" count={rows.length} active={filter === 'all'} onClick={() => setFilter('all')} />
                    {presentProcessors.map((p) => (
                      <FilterChip
                        key={p.id}
                        label={p.label}
                        count={counts[p.id] ?? 0}
                        active={filter === p.id}
                        onClick={() => setFilter(p.id)}
                      />
                    ))}
                  </div>
                )}

                {visibleRows.length === 0 ? (
                  <div className="rounded-2xl border border-amber-100 bg-white px-6 py-8 text-center text-sm text-zinc-500 shadow-sm dark:border-amber-900/30 dark:bg-zinc-900/40 dark:text-zinc-400">
                    No MESA disbursements routed to {filter === 'all' ? 'this processor' : PROCESSOR_LABEL[filter]}.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {visibleRows.map((r) => (
                      <UrgentCard
                        key={r.id}
                        row={r}
                        processor={processorFor(r)}
                        onProcessorChange={(p) => setProcessorFor(r.id, p)}
                        onSend={() => setMarkRow(r)}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* ── Orphanage budget requests ── */}
            {budgetItems.length > 0 && (
              <section className="space-y-3">
                <SectionHeader Icon={Banknote} title="Orphanage Budget Requests" count={budgetItems.length} />
                <div className="space-y-3">
                  {budgetItems.map((item) => (
                    <BudgetCard key={item.sourceId} item={item} onPay={() => setMarkBudget(item)} />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>

      <MarkPaidDialog
        row={markRow ? toQueueRow(markRow, processorFor(markRow)) : null}
        onClose={() => setMarkRow(null)}
        onConfirm={handleConfirm}
      />
      <OrphanageMarkPaidDialog
        item={markBudget}
        onClose={() => setMarkBudget(null)}
        onConfirm={handleConfirmBudget}
      />
    </div>
  );
}

function SectionHeader({
  Icon,
  title,
  count,
}: {
  Icon: React.ComponentType<{ className?: string }>;
  title: string;
  count: number;
}) {
  return (
    <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
      <Icon className="h-3.5 w-3.5 text-amber-500" />
      {title}
      <span className="ml-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
        {count}
      </span>
    </h3>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors',
        active
          ? 'border-amber-400 bg-amber-500 text-white dark:border-amber-500 dark:bg-amber-600'
          : 'border-zinc-200 bg-white text-zinc-600 hover:border-amber-300 hover:text-amber-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-amber-700/50',
      )}
    >
      {label}
      <span
        className={cn(
          'rounded-full px-1.5 py-px text-[10px] font-semibold tabular-nums',
          active ? 'bg-white/20 text-white' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
        )}
      >
        {count}
      </span>
    </button>
  );
}

function UrgentCard({
  row,
  processor,
  onProcessorChange,
  onSend,
}: {
  row: UrgentPaymentRow;
  processor: ProcessorId;
  onProcessorChange: (p: ProcessorId) => void;
  onSend: () => void;
}) {
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

      {/* Amount + processor + action */}
      <div className="flex items-center gap-3 sm:flex-col sm:items-end sm:gap-2">
        <div className="text-right">
          <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Amount</div>
          {row.amount_needed != null ? (
            <div className="font-mono text-lg font-bold tabular-nums text-zinc-900 dark:text-zinc-100">
              {formatPHP(row.amount_needed)}
            </div>
          ) : (
            <div className="text-sm text-zinc-400">—</div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor={`proc-${row.id}`}>Payment processor</label>
          <select
            id={`proc-${row.id}`}
            value={processor}
            onChange={(e) => onProcessorChange(e.target.value as ProcessorId)}
            className="h-8 rounded-md border border-amber-200 bg-amber-50/60 px-2 text-[12px] font-medium text-amber-800 outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-200 dark:border-amber-800/40 dark:bg-amber-950/20 dark:text-amber-200"
            title="Choose which processor to pay through"
          >
            {DISPATCH_PROCESSORS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
          <Button
            type="button"
            size="sm"
            onClick={onSend}
            className="gap-1.5 bg-amber-500 text-white hover:bg-amber-600 dark:bg-amber-600 dark:hover:bg-amber-500"
          >
            <Send className="h-3.5 w-3.5" />
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

function BudgetCard({
  item,
  onPay,
}: {
  item: OrphanagePendingItem;
  onPay: () => void;
}) {
  const br = item.budgetRequest;
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-amber-200/70 bg-white p-4 shadow-sm transition-shadow hover:shadow-md sm:flex-row sm:items-center sm:gap-4 dark:border-amber-800/30 dark:bg-zinc-900/60">
      {/* Icon */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-600 ring-1 ring-teal-100 dark:bg-teal-950/30 dark:text-teal-300 dark:ring-teal-900/40">
        <Banknote className="h-5 w-5" />
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="border-teal-200 bg-teal-50 text-[10px] font-bold uppercase tracking-wider text-teal-700 dark:border-teal-700/40 dark:bg-teal-950/30 dark:text-teal-300">
            Orphanage Budget
          </Badge>
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">{item.label}</span>
        </div>
        <div className="font-mono text-[11px] text-zinc-500 dark:text-zinc-500">{item.submitterEmail}</div>
        {br?.notes && (
          <p className="line-clamp-1 text-[11px] italic text-zinc-500 dark:text-zinc-400">&ldquo;{br.notes}&rdquo;</p>
        )}
        {(item.bankName || item.bankAccountNumber) && (
          <div className="flex flex-wrap items-center gap-1 pt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
            <Building2 className="h-3 w-3 shrink-0 text-teal-500" />
            {[item.bankName, item.bankAccountNumber].filter(Boolean).join(' · ')}
          </div>
        )}
      </div>

      {/* Amount + action */}
      <div className="flex items-center gap-3 sm:flex-col sm:items-end sm:gap-2">
        <div className="text-right">
          <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Amount</div>
          <div className="font-mono text-lg font-bold tabular-nums text-zinc-900 dark:text-zinc-100">
            {formatPHP(item.amountPhp)}
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={onPay}
          className="gap-1.5 bg-teal-600 text-white hover:bg-teal-700 dark:bg-teal-600 dark:hover:bg-teal-500"
        >
          <Send className="h-3.5 w-3.5" />
          Pay wire
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
