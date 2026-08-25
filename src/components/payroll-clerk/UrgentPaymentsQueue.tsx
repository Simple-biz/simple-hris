'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from 'next-auth/react';
import {
  Banknote,
  Building2,
  CheckCircle2,
  Clock,
  HeartHandshake,
  Loader2,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
  Wallet,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import OrphanageMarkPaidDialog, { type OrphanageMarkPaidPayload } from './OrphanageMarkPaidDialog';
import { PROCESSORS, DISPATCH_PROCESSORS, type ProcessorId, type QueueRow } from './mock-queue';
import type { OrphanagePendingItem } from '@/lib/supabase/orphanage-dispatches';
import type { PaymentDispatchRow, PaymentDispatchStatus } from '@/lib/supabase/payment-dispatches';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';

export interface UrgentPaymentRow {
  id: string;
  work_email: string;
  full_name: string;
  department: string;
  disbursement_reason: string | null;
  explanation: string | null;
  amount_needed: number | null;
  /** USD equivalent of `amount_needed`, converted server-side at the active FX rate. */
  amount_usd: number | null;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  /** Recipient's saved preferred processor (defaults to 'wise' for MESA). */
  processor: ProcessorId;
  /** Per-processor payout detail so Mark Paid pre-fills for the chosen processor. */
  details: QueueRow['details'];
}

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
  /** Recipient's saved preferred processor (defaults to 'wise'). */
  processor: ProcessorId;
  /** Per-processor payout detail so Mark Paid pre-fills for the chosen processor. */
  details: QueueRow['details'];
}

interface Props {
  /** Called whenever the count of pending urgent items changes (MESA + one-off + budget). */
  onCountChange?: (n: number) => void;
  /**
   * Called whenever the count of urgent payouts ALREADY dispatched this Sun→Sat
   * week changes (paid / not paid / threshold / problem). The parent keeps the
   * Urgent card visible while either count is non-zero, so paying the last
   * pending item no longer makes the whole bucket vanish.
   */
  onDispatchedCountChange?: (n: number) => void;
}

/**
 * Sub-views of the Urgent bucket. 'pending' is the live payable queue (MESA +
 * one-off + orphanage budget requests); the rest are this week's dispatch-log
 * views, one per recorded outcome — the same rail every processor bucket has,
 * so a paid urgent stays inspectable here instead of only in weekly Reports.
 */
type UrgentView = 'pending' | PaymentDispatchStatus;

const URGENT_VIEW_ORDER: UrgentView[] = ['pending', 'paid', 'not_paid', 'threshold', 'problem'];

/** Labels + active colors for the view rail — mirrors ProcessorQueue's strip so
 *  a clerk reads the same color for "problem" everywhere. */
const URGENT_VIEW_STYLES: Record<
  UrgentView,
  { label: string; activeText: string; activePill: string }
> = {
  pending: {
    label: 'Pending',
    activeText: 'bg-white text-amber-700 shadow-sm dark:bg-zinc-800 dark:text-amber-300',
    activePill: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300',
  },
  paid: {
    label: 'Paid',
    activeText: 'bg-white text-emerald-700 shadow-sm dark:bg-zinc-800 dark:text-emerald-300',
    activePill: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300',
  },
  not_paid: {
    label: 'Not paid',
    activeText: 'bg-white text-zinc-700 shadow-sm dark:bg-zinc-800 dark:text-zinc-200',
    activePill: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-600/40 dark:text-zinc-200',
  },
  threshold: {
    label: 'Threshold',
    activeText: 'bg-white text-amber-700 shadow-sm dark:bg-zinc-800 dark:text-amber-300',
    activePill: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300',
  },
  problem: {
    label: 'Problem',
    activeText: 'bg-white text-rose-700 shadow-sm dark:bg-zinc-800 dark:text-rose-300',
    activePill: 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300',
  },
};

/** Status pill on a dispatched card, matching the rail's color per outcome. */
const DISPATCH_STATUS_BADGE: Record<PaymentDispatchStatus, { label: string; className: string }> = {
  paid: {
    label: 'Paid',
    className:
      'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-700/40 dark:bg-emerald-950/30 dark:text-emerald-300',
  },
  not_paid: {
    label: 'Not paid',
    className:
      'border-zinc-200 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300',
  },
  threshold: {
    label: 'Threshold',
    className:
      'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-700/40 dark:bg-amber-950/30 dark:text-amber-300',
  },
  problem: {
    label: 'Problem',
    className:
      'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-700/40 dark:bg-rose-950/30 dark:text-rose-300',
  },
};

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

/**
 * A queue item the clerk asked to remove, held while the confirm dialog is open.
 * `kind` picks the endpoint AND the wording, because the two sources are removed
 * by different sanctioned paths: a MESA disbursement request is deleted outright
 * (MESA's own DELETE, which refuses anything already paid), while a one-off
 * payment is cancelled — its table carries a 'cancelled' status so the money
 * request keeps its paper trail. Both leave the Urgent bucket.
 */
type RemoveTarget = {
  kind: 'mesa' | 'oneoff';
  id: string;
  name: string;
  amountPhp: number | null;
};

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

// Build a QueueRow compatible with MarkPaidDialog from a MESA request + the
// processor the clerk picked for this payout.
function toQueueRow(r: UrgentPaymentRow, processor: ProcessorId): QueueRow {
  return {
    id: r.id,
    processor,
    name: r.full_name,
    email: r.work_email,
    // MESA disbursements are filed in PHP; the USD equivalent comes from the feed
    // so Mark Paid's secondary line shows a real dollar figure, not a dash.
    amountUSD: r.amount_usd,
    amountPHP: r.amount_needed,
    amountCOP: null,
    payCurrency: 'PHP',
    initialPayUSD: r.amount_usd,
    initialPayPHP: r.amount_needed,
    // A MESA disbursement is the whole payment, not a payroll row: it has no
    // bonus/orphanage/MESA-deduction split and no wizard carrier, so
    // `valuesSource` is deliberately absent.
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
    // MESA urgent payments aren't tied to a payroll department.
    departmentKey: null,
    departmentName: null,
    details: r.details ?? { email: r.work_email },
  };
}

// Build a QueueRow compatible with MarkPaidDialog from a one-off payment request.
function toQueueRowOneOff(r: UrgentOneOffRow, processor: ProcessorId): QueueRow {
  return {
    id: r.id,
    processor,
    name: r.full_name,
    email: r.work_email,
    // Filed in PHP; USD equivalent supplied by the feed (see toQueueRow).
    amountUSD: r.amount_usd,
    amountPHP: r.amount_php,
    amountCOP: null,
    payCurrency: 'PHP',
    initialPayUSD: r.amount_usd,
    initialPayPHP: r.amount_php,
    // Same as toQueueRow: a one-off is not a payroll row (see above).
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
    // One-off payments aren't tied to a payroll department.
    departmentKey: null,
    departmentName: null,
    details: r.details ?? { email: r.work_email },
  };
}

export default function UrgentPaymentsQueue({ onCountChange, onDispatchedCountChange }: Props) {
  const { data: session } = useSession();
  const userEmail = session?.user?.email ?? null;

  const [rows, setRows] = useState<UrgentPaymentRow[]>([]);
  const [oneOffRows, setOneOffRows] = useState<UrgentOneOffRow[]>([]);
  const [budgetItems, setBudgetItems] = useState<OrphanagePendingItem[]>([]);
  // Which sub-view is showing: the live pending queue or one of this week's
  // dispatch-log views (paid / not paid / threshold / problem).
  const [view, setView] = useState<UrgentView>('pending');
  // Urgent payouts already dispatched this Sun→Sat week, straight from the
  // weekly report's loader so the two can never disagree.
  const [dispatchedRows, setDispatchedRows] = useState<PaymentDispatchRow[]>([]);
  const [weekRange, setWeekRange] = useState<{ start: string; end: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [markRow, setMarkRow] = useState<UrgentPaymentRow | null>(null);
  const [markOneOff, setMarkOneOff] = useState<UrgentOneOffRow | null>(null);
  const [markBudget, setMarkBudget] = useState<OrphanagePendingItem | null>(null);
  // Per-row processor override the clerk picks on each MESA card. Defaults to
  // the recipient's preferred processor returned by the API.
  const [processorByRow, setProcessorByRow] = useState<Record<string, ProcessorId>>({});
  // Same, but for one-off payment cards.
  const [oneOffProcessorByRow, setOneOffProcessorByRow] = useState<Record<string, ProcessorId>>({});
  // Top filter rail — narrow the MESA queue to one processor.
  const [filter, setFilter] = useState<ProcessorId | 'all'>('all');
  // Pending removal awaiting confirmation (null = dialog closed).
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);
  const [removing, setRemoving] = useState(false);
  // Dispatched payout awaiting Undo confirmation (null = dialog closed).
  const [undoTarget, setUndoTarget] = useState<PaymentDispatchRow | null>(null);
  const [undoing, setUndoing] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); else setRefreshing(true);
    try {
      const [mesaRes, oneOffRes, orphRes, dispatchedRes] = await Promise.all([
        fetch('/api/urgent-payments', { cache: 'no-store' }),
        fetch('/api/urgent-payments/requests', { cache: 'no-store' }),
        fetch('/api/orphanage-dispatches?pending=1', { cache: 'no-store' }),
        fetch('/api/urgent-payments/dispatches', { cache: 'no-store' }),
      ]);
      if (!mesaRes.ok) throw new Error(`HTTP ${mesaRes.status}`);
      const mesaJson = (await mesaRes.json()) as { rows?: UrgentPaymentRow[]; error?: string };
      if (mesaJson.error) throw new Error(mesaJson.error);
      const mesa = mesaJson.rows ?? [];
      setRows(mesa);

      // One-off payments (People tab "Pay") — best-effort: a failure here must
      // not break the MESA queue.
      let oneOff: UrgentOneOffRow[] = [];
      try {
        const oneOffJson = (await oneOffRes.json()) as { rows?: UrgentOneOffRow[]; error?: string };
        if (oneOffRes.ok && !oneOffJson.error) oneOff = oneOffJson.rows ?? [];
      } catch {
        /* ignore — one-off section silently omitted */
      }
      setOneOffRows(oneOff);

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
      onCountChange?.(mesa.length + oneOff.length + budget.length);

      // This week's dispatch log — best-effort: a failure here must not break
      // the pending queue. On failure we keep the previous rows rather than
      // blanking the Paid/Not paid views.
      try {
        const dispatchedJson = (await dispatchedRes.json()) as {
          rows?: PaymentDispatchRow[];
          week?: { start: string; end: string } | null;
          error?: string;
        };
        if (dispatchedRes.ok && !dispatchedJson.error) {
          const dispatched = dispatchedJson.rows ?? [];
          setDispatchedRows(dispatched);
          setWeekRange(dispatchedJson.week ?? null);
          onDispatchedCountChange?.(dispatched.length);
        }
      } catch {
        /* ignore — dispatch-log views silently keep their last data */
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load urgent payments');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [onCountChange, onDispatchedCountChange]);

  useEffect(() => { void load(); }, [load]);

  // Resolve the rail for a MESA row: the clerk's override, else the rail
  // Payment Dispatch would use (server-resolved with PD's full precedence).
  // NULL when the recipient has no resolvable rail — the clerk must pick one.
  // This used to fall back to 'wise', which silently preselected a RETIRED
  // processor for anyone routed via bank_preferred or the rates sheet, and one
  // click recorded a real dispatch on a rail they aren't set up on.
  const processorFor = useCallback(
    (r: UrgentPaymentRow): ProcessorId | null => processorByRow[r.id] ?? r.processor ?? null,
    [processorByRow],
  );

  const setProcessorFor = useCallback((rowId: string, processor: ProcessorId) => {
    setProcessorByRow((prev) => ({ ...prev, [rowId]: processor }));
  }, []);

  // Same resolution for one-off payment rows.
  const processorForOneOff = useCallback(
    (r: UrgentOneOffRow): ProcessorId | null => oneOffProcessorByRow[r.id] ?? r.processor ?? null,
    [oneOffProcessorByRow],
  );

  const setOneOffProcessorFor = useCallback((rowId: string, processor: ProcessorId) => {
    setOneOffProcessorByRow((prev) => ({ ...prev, [rowId]: processor }));
  }, []);

  // Count MESA rows per processor (using the chosen processor) for the filter rail.
  const counts = useMemo(() => {
    const c: Partial<Record<ProcessorId, number>> = {};
    for (const r of rows) {
      const p = processorFor(r);
      if (!p) continue; // no resolvable rail — counted under no processor tab
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
    // No resolvable rail — refuse rather than guess. Recording a dispatch on a
    // guessed processor sends money down a rail the payee isn't set up on.
    if (!processor) {
      toast.error(`${target.full_name} has no payment rail on file — pick one before sending.`);
      return;
    }

    // Optimistically remove from list
    const nextRows = rows.filter((r) => r.id !== payload.rowId);
    setRows(nextRows);
    onCountChange?.(nextRows.length + oneOffRows.length + budgetItems.length);
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
      // Rollback optimistic removal. Recompute the count from the ACTUAL restored
      // list (a concurrent silent load() may have replaced rows meanwhile), and
      // skip re-adding if the refresh already brought this row back — otherwise
      // we'd duplicate it and desync the badge from the visible cards.
      setRows((prev) => {
        const next = prev.some((r) => r.id === target.id) ? prev : [target, ...prev];
        onCountChange?.(next.length + oneOffRows.length + budgetItems.length);
        return next;
      });
      toast.error(e instanceof Error ? e.message : 'Dispatch failed');
    }
  };

  const handleConfirmOneOff = async (payload: MarkPaidPayload) => {
    const target = oneOffRows.find((r) => r.id === payload.rowId);
    if (!target) return;
    const processor = processorForOneOff(target);
    if (!processor) {
      toast.error(`${target.full_name} has no payment rail on file — pick one before sending.`);
      return;
    }

    // Optimistically remove from list
    const nextRows = oneOffRows.filter((r) => r.id !== payload.rowId);
    setOneOffRows(nextRows);
    onCountChange?.(rows.length + nextRows.length + budgetItems.length);
    setMarkOneOff(null);

    try {
      const res = await fetch(`/api/urgent-payments/requests/${payload.rowId}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient_email: target.work_email,
          recipient_name: target.full_name,
          amount_php: target.amount_php,
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
      toast.success(`${target.full_name} — payment sent via ${PROCESSOR_LABEL[processor]}`);
      void load(true);
    } catch (e) {
      // Rollback optimistic removal. Recompute from the ACTUAL restored list and
      // skip re-adding if a concurrent refresh already restored this row.
      setOneOffRows((prev) => {
        const next = prev.some((r) => r.id === target.id) ? prev : [target, ...prev];
        onCountChange?.(rows.length + next.length + budgetItems.length);
        return next;
      });
      toast.error(e instanceof Error ? e.message : 'Dispatch failed');
    }
  };

  /**
   * Remove the confirmed item from the queue. Awaits the server before dropping
   * the card — unlike Send (which is optimistic to keep the clerk moving), a
   * failed removal must leave the payment plainly still there rather than
   * flashing it away and back.
   */
  const handleRemove = async () => {
    if (!removeTarget || removing) return;
    const target = removeTarget;
    setRemoving(true);
    try {
      const url =
        target.kind === 'mesa'
          ? `/api/mesa-requests/${encodeURIComponent(target.id)}`
          : `/api/urgent-payments/requests/${encodeURIComponent(target.id)}`;
      const res = await fetch(url, { method: 'DELETE' });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Could not remove this payment');

      if (target.kind === 'mesa') {
        setRows((prev) => {
          const next = prev.filter((r) => r.id !== target.id);
          onCountChange?.(next.length + oneOffRows.length + budgetItems.length);
          return next;
        });
      } else {
        setOneOffRows((prev) => {
          const next = prev.filter((r) => r.id !== target.id);
          onCountChange?.(rows.length + next.length + budgetItems.length);
          return next;
        });
      }
      setRemoveTarget(null);
      toast.success(`Removed — ${target.name} will not be paid from this queue.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove this payment');
    } finally {
      setRemoving(false);
    }
  };

  /**
   * Undo a dispatched urgent payout: the server removes the money log and
   * returns the source request to the pending queue (see
   * /api/urgent-payments/dispatches/undo). Awaits the server before dropping
   * the card — like Remove, a failed undo must leave the payment plainly
   * still in the log view so it can be retried.
   */
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
    onCountChange?.(rows.length + oneOffRows.length + nextBudget.length);
  };

  const hasAny = rows.length > 0 || oneOffRows.length > 0 || budgetItems.length > 0;
  const pendingCount = rows.length + oneOffRows.length + budgetItems.length;

  // Per-outcome counts for the view rail, from this week's dispatch log.
  const statusCounts = useMemo(() => {
    const c: Record<PaymentDispatchStatus, number> = { paid: 0, not_paid: 0, threshold: 0, problem: 0 };
    for (const r of dispatchedRows) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [dispatchedRows]);

  const dispatchedVisible = useMemo(
    () => (view === 'pending' ? [] : dispatchedRows.filter((r) => r.status === view)),
    [dispatchedRows, view],
  );

  const weekLabel = useMemo(() => {
    if (!weekRange) return null;
    const start = formatDateOnly(weekRange.start);
    const end = formatDateOnly(weekRange.end);
    return start && end ? `${start} – ${end}` : null;
  }, [weekRange]);

  // Memoize the QueueRow handed to each MarkPaidDialog. toQueueRow* build a fresh
  // object literal every call, and MarkPaidDialog resets the clerk's typed
  // transaction id / bank / dates whenever its `row` reference changes — so an
  // inline prop would wipe those fields on any parent re-render (a Refresh, a
  // ping toast, another card's processor change) while the dialog is open. A
  // stable reference (keyed on the open target + chosen processor) keeps them.
  // A null rail yields no queue row, so Mark Paid stays shut until the clerk
  // picks a processor on the card — the dialog pre-fills per rail, and there is
  // no safe rail to pre-fill for someone with none on file.
  const markRowQueue = useMemo(() => {
    if (!markRow) return null;
    const p = processorFor(markRow);
    return p ? toQueueRow(markRow, p) : null;
  }, [markRow, processorFor]);
  const markOneOffQueue = useMemo(() => {
    if (!markOneOff) return null;
    const p = processorForOneOff(markOneOff);
    return p ? toQueueRowOneOff(markOneOff, p) : null;
  }, [markOneOff, processorForOneOff]);

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
                MESA disbursements, one-off payments, and approved orphanage budget requests awaiting
                immediate payout. These bypass the weekly payroll cycle and reconcile in the weekly report.
                Payouts already dispatched stay under Paid / Not paid until the week rolls over.
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

        {/* View rail — live pending queue vs this week's dispatch-log views.
            Always rendered once loaded (even at 0 everywhere), so the bucket
            reads like every other processor bucket instead of vanishing. */}
        {!loading && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div
              role="tablist"
              aria-label="Urgent payments view"
              className="inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-amber-100 bg-amber-50/40 p-0.5 dark:border-zinc-800 dark:bg-zinc-900/60"
            >
              {URGENT_VIEW_ORDER.map((id) => {
                const active = view === id;
                const s = URGENT_VIEW_STYLES[id];
                const count = id === 'pending' ? pendingCount : statusCounts[id];
                return (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setView(id)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors',
                      active
                        ? s.activeText
                        : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200',
                    )}
                  >
                    {s.label}
                    <span
                      className={cn(
                        'rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums',
                        active
                          ? s.activePill
                          : 'bg-zinc-200/70 text-zinc-500 dark:bg-zinc-700/60 dark:text-zinc-400',
                      )}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
            {weekLabel && view !== 'pending' && (
              <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                This week · {weekLabel}
              </span>
            )}
          </div>
        )}

        {/* Body */}
        {loading ? (
          <SkeletonRows />
        ) : view !== 'pending' ? (
          dispatchedVisible.length === 0 ? (
            <div className="rounded-2xl border border-amber-100 bg-white px-6 py-12 text-center text-sm text-zinc-500 shadow-sm dark:border-amber-900/30 dark:bg-zinc-900/40 dark:text-zinc-400">
              No urgent payments logged as {URGENT_VIEW_STYLES[view].label.toLowerCase()} this week
              {weekLabel ? ` (${weekLabel})` : ''}. Past weeks live in Reports.
            </div>
          ) : (
            <div className="space-y-3">
              {dispatchedVisible.map((r) => (
                <DispatchedCard key={r.id} row={r} onUndo={() => setUndoTarget(r)} />
              ))}
            </div>
          )
        ) : !hasAny ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-amber-100 bg-white px-6 py-16 text-center shadow-sm dark:border-amber-900/30 dark:bg-zinc-900/40">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-500 dark:bg-emerald-950/30 dark:text-emerald-400">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <div>
              <p className="font-semibold text-zinc-900 dark:text-white">All clear</p>
              <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
                No MESA disbursements, one-off payments, or orphanage budget requests pending dispatch.
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
                        onRemove={() =>
                          setRemoveTarget({
                            kind: 'mesa',
                            id: r.id,
                            name: r.full_name,
                            amountPhp: r.amount_needed,
                          })
                        }
                      />
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* ── One-off payments (People tab "Pay") ── */}
            {oneOffRows.length > 0 && (
              <section className="space-y-3">
                <SectionHeader Icon={Wallet} title="One-off Payments" count={oneOffRows.length} />
                <div className="space-y-3">
                  {oneOffRows.map((r) => (
                    <OneOffCard
                      key={r.id}
                      row={r}
                      processor={processorForOneOff(r)}
                      onProcessorChange={(p) => setOneOffProcessorFor(r.id, p)}
                      onSend={() => setMarkOneOff(r)}
                      onRemove={() =>
                        setRemoveTarget({
                          kind: 'oneoff',
                          id: r.id,
                          name: r.full_name,
                          amountPhp: r.amount_php,
                        })
                      }
                    />
                  ))}
                </div>
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
        row={markRowQueue}
        onClose={() => setMarkRow(null)}
        onConfirm={handleConfirm}
      />
      <MarkPaidDialog
        row={markOneOffQueue}
        onClose={() => setMarkOneOff(null)}
        onConfirm={handleConfirmOneOff}
      />
      <OrphanageMarkPaidDialog
        item={markBudget}
        onClose={() => setMarkBudget(null)}
        onConfirm={handleConfirmBudget}
      />

      {/* Remove confirmation — money-adjacent, so never a one-click delete. */}
      <Dialog
        open={removeTarget != null}
        onOpenChange={(o) => { if (!o && !removing) setRemoveTarget(null); }}
      >
        <DialogContent className="sm:max-w-[420px]">
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-400">
              <Trash2 className="h-4 w-4" />
            </span>
            {removeTarget?.kind === 'mesa' ? 'Delete disbursement?' : 'Delete payment?'}
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed">
            {removeTarget && (
              <>
                <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                  {removeTarget.name}
                </span>
                {removeTarget.amountPhp != null && (
                  <>
                    {' — '}
                    <span className="font-mono font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                      {formatPHP(removeTarget.amountPhp)}
                    </span>
                  </>
                )}
                {removeTarget.kind === 'mesa'
                  ? '. This removes the approved MESA disbursement request entirely — nothing is paid, and it will not come back to this queue.'
                  : '. This cancels the one-off payment request — nothing is paid, and it leaves this queue for good.'}
              </>
            )}
          </DialogDescription>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={removing}
              onClick={() => setRemoveTarget(null)}
            >
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
      <Dialog
        open={undoTarget != null}
        onOpenChange={(o) => { if (!o && !undoing) setUndoTarget(null); }}
      >
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
                      {formatPHP(Number(undoTarget.amount_php))}
                    </span>
                  </>
                )}
                . This deletes the logged payment record and returns the request to the pending
                queue so it can be sent again. It does not reverse any money already sent.
              </>
            )}
          </DialogDescription>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={undoing}
              onClick={() => setUndoTarget(null)}
            >
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

/**
 * Amount block on an urgent card. The USD equivalent leads because the dispatch
 * queue and the weekly report both headline in dollars; the peso figure the
 * request was actually filed in sits beneath it. Falls back to peso-only if the
 * conversion is unavailable, so a missing FX rate never blanks the amount.
 */
function AmountBlock({ php, usd }: { php: number | null; usd: number | null }) {
  return (
    <div className="text-right">
      <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
        Amount
      </div>
      {php == null ? (
        <div className="text-sm text-zinc-400">—</div>
      ) : usd == null ? (
        <div className="font-mono text-lg font-bold tabular-nums text-zinc-900 dark:text-zinc-100">
          {formatPHP(php)}
        </div>
      ) : (
        <>
          <div className="font-mono text-lg font-bold tabular-nums text-zinc-900 dark:text-zinc-100">
            {formatUSD(usd)}
          </div>
          <div className="font-mono text-[11px] font-medium tabular-nums text-zinc-500 dark:text-zinc-400">
            {formatPHP(php)}
          </div>
        </>
      )}
    </div>
  );
}

/** Trash affordance shared by the removable urgent cards. */
function RemoveButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      aria-label={title}
      title={title}
      className="h-8 w-8 shrink-0 border-zinc-200 p-0 text-zinc-400 transition-colors hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:border-zinc-700 dark:text-zinc-500 dark:hover:border-rose-800/60 dark:hover:bg-rose-950/30 dark:hover:text-rose-400"
    >
      <Trash2 className="h-3.5 w-3.5" />
    </Button>
  );
}

function UrgentCard({
  row,
  processor,
  onProcessorChange,
  onSend,
  onRemove,
}: {
  row: UrgentPaymentRow;
  /** Null when the recipient has no rail on file — Send stays disabled until
   *  the clerk picks one, rather than defaulting to a guess. */
  processor: ProcessorId | null;
  onProcessorChange: (p: ProcessorId) => void;
  onSend: () => void;
  onRemove: () => void;
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
        <AmountBlock php={row.amount_needed} usd={row.amount_usd} />
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor={`proc-${row.id}`}>Payment processor</label>
          <select
            id={`proc-${row.id}`}
            value={processor ?? ''}
            onChange={(e) => onProcessorChange(e.target.value as ProcessorId)}
            className="h-8 rounded-md border border-amber-200 bg-amber-50/60 px-2 text-[12px] font-medium text-amber-800 outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-200 dark:border-amber-800/40 dark:bg-amber-950/20 dark:text-amber-200"
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
            className="gap-1.5 bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 dark:bg-amber-600 dark:hover:bg-amber-500"
          >
            <Send className="h-3.5 w-3.5" />
            Send
          </Button>
          <RemoveButton onClick={onRemove} title="Delete this disbursement" />
        </div>
      </div>
    </div>
  );
}

function OneOffCard({
  row,
  processor,
  onProcessorChange,
  onSend,
  onRemove,
}: {
  row: UrgentOneOffRow;
  /** Null when the recipient has no rail on file — see UrgentCard. */
  processor: ProcessorId | null;
  onProcessorChange: (p: ProcessorId) => void;
  onSend: () => void;
  onRemove: () => void;
}) {
  const requestedDate = new Date(row.requested_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-amber-200/70 bg-white p-4 shadow-sm transition-shadow hover:shadow-md sm:flex-row sm:items-center sm:gap-4 dark:border-amber-800/30 dark:bg-zinc-900/60">
      {/* Icon */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600 ring-1 ring-amber-100 dark:bg-amber-950/30 dark:text-amber-300 dark:ring-amber-900/40">
        <Wallet className="h-5 w-5" />
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">{row.full_name}</span>
          {row.department && <span className="text-xs text-zinc-400 dark:text-zinc-500" title={row.department}>{formatDeptLabel(row.department)}</span>}
        </div>
        <div className="font-mono text-[11px] text-zinc-500 dark:text-zinc-500">{row.work_email}</div>
        {row.note && (
          <p className="line-clamp-1 pt-1 text-[11px] text-zinc-500 dark:text-zinc-400">{row.note}</p>
        )}
        <div className="flex flex-wrap gap-3 pt-1">
          <span className="flex items-center gap-1 text-[11px] text-zinc-400 dark:text-zinc-500">
            <Clock className="h-3 w-3" />
            Requested {requestedDate}
            {row.requested_by && <span className="text-zinc-400 dark:text-zinc-500">by {row.requested_by.split('@')[0]}</span>}
          </span>
        </div>
      </div>

      {/* Amount + processor + action */}
      <div className="flex items-center gap-3 sm:flex-col sm:items-end sm:gap-2">
        <AmountBlock php={row.amount_php} usd={row.amount_usd} />
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor={`oneoff-proc-${row.id}`}>Payment processor</label>
          <select
            id={`oneoff-proc-${row.id}`}
            value={processor ?? ''}
            onChange={(e) => onProcessorChange(e.target.value as ProcessorId)}
            className="h-8 rounded-md border border-amber-200 bg-amber-50/60 px-2 text-[12px] font-medium text-amber-800 outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-200 dark:border-amber-800/40 dark:bg-amber-950/20 dark:text-amber-200"
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
            className="gap-1.5 bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 dark:bg-amber-600 dark:hover:bg-amber-500"
          >
            <Send className="h-3.5 w-3.5" />
            Send
          </Button>
          <RemoveButton onClick={onRemove} title="Delete this payment" />
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

/**
 * Card for an urgent payout already dispatched this week (paid / not paid /
 * threshold / problem). Undo removes the money log and sends the request back
 * to the pending queue; other edits stay in the weekly Reports detail.
 */
function DispatchedCard({ row, onUndo }: { row: PaymentDispatchRow; onUndo: () => void }) {
  const badge = DISPATCH_STATUS_BADGE[row.status];
  const sentDate = formatDateOnly(row.sent_date);
  const arrivalDate = formatDateOnly(row.arrival_date);
  const processorLabel = PROCESSOR_LABEL[row.processor as ProcessorId] ?? row.processor;

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-amber-200/70 bg-white p-4 shadow-sm transition-shadow hover:shadow-md sm:flex-row sm:items-center sm:gap-4 dark:border-amber-800/30 dark:bg-zinc-900/60">
      {/* Icon */}
      <div
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1',
          row.status === 'paid'
            ? 'bg-emerald-50 text-emerald-600 ring-emerald-100 dark:bg-emerald-950/30 dark:text-emerald-300 dark:ring-emerald-900/40'
            : row.status === 'problem'
              ? 'bg-rose-50 text-rose-600 ring-rose-100 dark:bg-rose-950/30 dark:text-rose-300 dark:ring-rose-900/40'
              : 'bg-amber-50 text-amber-600 ring-amber-100 dark:bg-amber-950/30 dark:text-amber-300 dark:ring-amber-900/40',
        )}
      >
        <CheckCircle2 className="h-5 w-5" />
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">
            {row.recipient_name ?? row.recipient_email}
          </span>
          <Badge variant="outline" className={cn('text-[10px] font-bold uppercase tracking-wider', badge.className)}>
            {badge.label}
          </Badge>
        </div>
        <div className="font-mono text-[11px] text-zinc-500 dark:text-zinc-500">{row.recipient_email}</div>
        {row.note && (
          <p className="line-clamp-1 pt-1 text-[11px] text-zinc-500 dark:text-zinc-400">{row.note}</p>
        )}
        <div className="flex flex-wrap gap-3 pt-1">
          {sentDate && (
            <span className="flex items-center gap-1 text-[11px] text-zinc-400 dark:text-zinc-500">
              <Clock className="h-3 w-3" />
              Sent {sentDate}
              {arrivalDate && <span className="text-zinc-400 dark:text-zinc-500">· arrives {arrivalDate}</span>}
            </span>
          )}
          {row.bank_used && (
            <span className="flex items-center gap-1 text-[11px] text-zinc-400 dark:text-zinc-500">
              <Building2 className="h-3 w-3" />
              {row.bank_used}
            </span>
          )}
          {row.transaction_id && (
            <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
              #{row.transaction_id}
            </span>
          )}
        </div>
      </div>

      {/* Amount + processor + undo */}
      <div className="flex items-center gap-3 sm:flex-col sm:items-end sm:gap-2">
        <AmountBlock php={row.amount_php} usd={row.amount_usd} />
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:border-amber-800/40 dark:bg-amber-950/20 dark:text-amber-200">
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
