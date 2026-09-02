'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from 'next-auth/react';
import { motion, AnimatePresence } from 'motion/react';
import QueuePagination from './QueuePagination';
import {
  AlertTriangle,
  Banknote,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Gift,
  GraduationCap,
  Hammer,
  Heart,
  Loader2,
  MapPin,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import OrphanageMarkPaidDialog, { type OrphanageMarkPaidPayload } from './OrphanageMarkPaidDialog';
import OrphanageWorkerPaymentDialog from './OrphanageWorkerPaymentDialog';
import type { OrphanagePendingItem } from '@/lib/supabase/orphanage-dispatches';
import { workerTypeLabel } from '@/lib/orphanage/worker-payment';

function formatPHP(v: number | null | undefined) {
  if (v == null) return '—';
  return `₱${v.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(iso: string | null | undefined) {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

// ─── Item card ──────────────────────────────────────────────────────────────

function OrphanageItemCard({
  item,
  onMarkPaid,
  onEdit,
  onDelete,
}: {
  item: OrphanagePendingItem;
  onMarkPaid: (item: OrphanagePendingItem) => void;
  onEdit?: (item: OrphanagePendingItem) => void;
  onDelete?: (item: OrphanagePendingItem) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const br = item.budgetRequest;
  const gs = item.giftShipping;
  const wp = item.workerPayment;

  const isBudget = item.sourceType === 'budget_request';
  const isWorker = item.sourceType === 'worker_payment';
  // Intern items (accepted intern weeks) — violet, the one accent this queue
  // did not already use. Their bank is READ-ONLY here: it changes on the
  // Orphanage dashboard (intern profile / orphanage directory), never at pay time.
  const isIntern = item.sourceType === 'intern_pay' || item.sourceType === 'intern_orphanage_share';
  const accentClass = isIntern
    ? 'border-violet-200/80 dark:border-violet-900/40'
    : isWorker
    ? 'border-emerald-200/80 dark:border-emerald-900/40'
    : isBudget
      ? 'border-teal-200/80 dark:border-teal-900/40'
      : 'border-pink-200/80 dark:border-pink-900/40';
  const badgeClass = isIntern
    ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300'
    : isWorker
    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
    : isBudget
      ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300'
      : 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300';
  const badgeLabel = isIntern
    ? (item.internPayee === 'orphanage' ? 'Orphanage share' : 'Intern')
    : isWorker
    ? (wp ? workerTypeLabel(wp) : 'Worker')
    : isBudget
      ? 'Budget Request'
      : 'Gift';

  const hasBankInfo = item.bankName || item.bankAccountNumber || item.bankAccountName || item.swiftCode;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      className={cn(
        'rounded-2xl border bg-white shadow-sm dark:bg-zinc-950',
        accentClass,
      )}
    >
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
        {/* Left */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider', badgeClass)}>
              {badgeLabel}
            </span>
            <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {item.label}
            </span>
          </div>

          <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
            {item.submitterEmail}
            {br && (
              <> · Submitted {formatDate(br.submitted_at)}</>
            )}
            {gs && gs.decided_at && (
              <> · Approved {formatDate(gs.decided_at)}</>
            )}
            {wp && (
              <>{wp.created_by ? `Added by ${wp.created_by}` : 'Added'} · {formatDate(wp.created_at)}</>
            )}
          </p>

          {/* Budget request extra info */}
          {br && br.notes && (
            <p className="mt-1 text-[11px] italic text-zinc-500 dark:text-zinc-400">
              &ldquo;{br.notes}&rdquo;
            </p>
          )}

          {/* Worker payment note */}
          {wp && wp.note && (
            <p className="mt-1 text-[11px] italic text-zinc-500 dark:text-zinc-400">
              &ldquo;{wp.note}&rdquo;
            </p>
          )}

          {/* Gift shipping extra info */}
          {gs && (
            <div className="mt-1.5 flex flex-col gap-0.5">
              {gs.gift_name && (
                <div className="flex items-center gap-1 text-[11px] text-zinc-600 dark:text-zinc-400">
                  <Gift className="h-3 w-3 shrink-0 text-pink-500" />
                  {gs.gift_name}
                </div>
              )}
              {gs.preferred_delivery_location && (
                <div className="flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-500">
                  <MapPin className="h-3 w-3 shrink-0" />
                  {gs.preferred_delivery_location}
                </div>
              )}
              {gs.active_contact_number && (
                <div className="flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-500">
                  <Phone className="h-3 w-3 shrink-0" />
                  {gs.active_contact_number}
                </div>
              )}
            </div>
          )}

          {/* Expandable bank info */}
          {hasBankInfo && (
            <div className="mt-3">
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="flex items-center gap-1 text-[11px] font-medium text-teal-700 hover:text-teal-900 dark:text-teal-400 dark:hover:text-teal-300"
              >
                <Building2 className="h-3 w-3" />
                {expanded ? 'Hide' : 'Show'} bank details
                {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </button>
              <AnimatePresence>
                {expanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className="mt-2 grid gap-1 rounded-xl border border-teal-100 bg-teal-50/60 p-3 text-[11px] dark:border-teal-900/30 dark:bg-teal-950/20">
                      {item.bankName && (
                        <div className="flex justify-between gap-2">
                          <span className="text-zinc-500 dark:text-zinc-500">Bank</span>
                          <span className="font-medium text-zinc-900 dark:text-zinc-100">{item.bankName}</span>
                        </div>
                      )}
                      {item.bankAccountName && (
                        <div className="flex justify-between gap-2">
                          <span className="text-zinc-500 dark:text-zinc-500">Account holder</span>
                          <span className="font-medium text-zinc-900 dark:text-zinc-100">{item.bankAccountName}</span>
                        </div>
                      )}
                      {item.bankAccountNumber && (
                        <div className="flex justify-between gap-2">
                          <span className="text-zinc-500 dark:text-zinc-500">Account number</span>
                          <span className="font-mono font-medium text-zinc-900 dark:text-zinc-100">{item.bankAccountNumber}</span>
                        </div>
                      )}
                      {item.swiftCode && (
                        <div className="flex justify-between gap-2">
                          <span className="text-zinc-500 dark:text-zinc-500">SWIFT</span>
                          <span className="font-mono font-medium text-zinc-900 dark:text-zinc-100">{item.swiftCode}</span>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          {!hasBankInfo && (item.sourceType === 'gift_shipping' || isWorker) && (
            <p className="mt-2 text-[11px] text-zinc-400 dark:text-zinc-600">
              No bank on file — enter details in the payment dialog.
            </p>
          )}
        </div>

        {/* Right — amount + action */}
        <div className="flex shrink-0 flex-col items-end gap-2 self-start sm:items-end">
          <span className="text-xl font-bold tabular-nums text-zinc-900 dark:text-zinc-100">
            {formatPHP(item.amountPhp)}
          </span>
          <Button
            size="sm"
            onClick={() => onMarkPaid(item)}
            className={cn(
              'h-8 gap-1.5 px-3 text-xs font-semibold text-white shadow-sm',
              isWorker
                ? 'bg-gradient-to-br from-emerald-500 to-teal-600 hover:brightness-110'
                : isBudget
                  ? 'bg-gradient-to-br from-teal-500 to-emerald-600 hover:brightness-110'
                  : 'bg-gradient-to-br from-pink-500 to-rose-600 hover:brightness-110',
            )}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Mark paid
          </Button>
          {isWorker && (onEdit || onDelete) && (
            <div className="flex items-center gap-1">
              {onEdit && (
                <button
                  type="button"
                  onClick={() => onEdit(item)}
                  title="Edit payment"
                  className="flex h-7 items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 text-[11px] font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-900"
                >
                  <Pencil className="h-3 w-3" /> Edit
                </button>
              )}
              {onDelete && (
                <button
                  type="button"
                  onClick={() => onDelete(item)}
                  title="Remove payment"
                  className="flex h-7 items-center gap-1 rounded-md border border-rose-200 bg-white px-2 text-[11px] font-medium text-rose-600 hover:bg-rose-50 dark:border-rose-900/40 dark:bg-zinc-950 dark:text-rose-400 dark:hover:bg-rose-950/30"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export default function OrphanageQueue() {
  const { data: session } = useSession();
  const userEmail = session?.user?.email ?? null;

  const [items, setItems] = useState<OrphanagePendingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [markPaidItem, setMarkPaidItem] = useState<OrphanagePendingItem | null>(null);
  // Add/edit worker-payment dialog. `workerDialogOpen` gates visibility;
  // `editingWorker` non-null = edit mode, null = add mode.
  const [workerDialogOpen, setWorkerDialogOpen] = useState(false);
  const [editingWorker, setEditingWorker] = useState<OrphanagePendingItem | null>(null);

  const fetchItems = useCallback(async (opts?: { silent?: boolean }) => {
    // Silent refetches (after add/edit) skip the full-screen spinner so the tab
    // doesn't blank out — the list just updates in place.
    if (!opts?.silent) setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/orphanage-dispatches?pending=1', { cache: 'no-store' });
      const json = (await res.json()) as { items?: OrphanagePendingItem[]; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to load');
      setItems(json.items ?? []);
    } catch (e) {
      if (!opts?.silent) {
        setError(e instanceof Error ? e.message : 'Could not load orphanage queue');
      } else {
        // A silent refetch (post add/edit) shouldn't blank the tab, but a failure
        // still means the list is stale — tell the user to refresh rather than
        // leaving them staring at out-of-date cards with no signal.
        console.warn('[orphanage-queue] silent refresh failed', e);
        toast.error('Saved, but the list may be out of date — hit Refresh.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchItems(); }, [fetchItems]);

  const budgetItems = useMemo(() => items.filter((i) => i.sourceType === 'budget_request'), [items]);
  const giftItems = useMemo(() => items.filter((i) => i.sourceType === 'gift_shipping'), [items]);
  const workerItems = useMemo(() => items.filter((i) => i.sourceType === 'worker_payment'), [items]);
  const internItems = useMemo(
    () => items.filter((i) => i.sourceType === 'intern_pay' || i.sourceType === 'intern_orphanage_share'),
    [items],
  );

  const PAGE_SIZE = 25;
  const [budgetPage, setBudgetPage] = useState(1);
  const [giftPage, setGiftPage] = useState(1);
  const [workerPage, setWorkerPage] = useState(1);
  const [internPage, setInternPage] = useState(1);
  const budgetPageCount = Math.max(1, Math.ceil(budgetItems.length / PAGE_SIZE));
  const giftPageCount = Math.max(1, Math.ceil(giftItems.length / PAGE_SIZE));
  const workerPageCount = Math.max(1, Math.ceil(workerItems.length / PAGE_SIZE));
  const internPageCount = Math.max(1, Math.ceil(internItems.length / PAGE_SIZE));
  useEffect(() => { if (budgetPage > budgetPageCount) setBudgetPage(budgetPageCount); }, [budgetPage, budgetPageCount]);
  useEffect(() => { if (giftPage > giftPageCount) setGiftPage(giftPageCount); }, [giftPage, giftPageCount]);
  useEffect(() => { if (workerPage > workerPageCount) setWorkerPage(workerPageCount); }, [workerPage, workerPageCount]);
  useEffect(() => { if (internPage > internPageCount) setInternPage(internPageCount); }, [internPage, internPageCount]);
  const pagedInternItems = useMemo(
    () => internItems.slice((internPage - 1) * PAGE_SIZE, internPage * PAGE_SIZE),
    [internItems, internPage],
  );
  const pagedBudgetItems = useMemo(
    () => budgetItems.slice((budgetPage - 1) * PAGE_SIZE, budgetPage * PAGE_SIZE),
    [budgetItems, budgetPage],
  );
  const pagedGiftItems = useMemo(
    () => giftItems.slice((giftPage - 1) * PAGE_SIZE, giftPage * PAGE_SIZE),
    [giftItems, giftPage],
  );
  const pagedWorkerItems = useMemo(
    () => workerItems.slice((workerPage - 1) * PAGE_SIZE, workerPage * PAGE_SIZE),
    [workerItems, workerPage],
  );

  const handleConfirmPaid = async (item: OrphanagePendingItem, payload: OrphanageMarkPaidPayload) => {
    const res = await fetch('/api/orphanage-dispatches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_type: item.sourceType,
        source_id: item.sourceId,
        // Worker payments have no employee to join back to — snapshot the name +
        // type onto the dispatch row so Reports can label it.
        recipient_name: item.workerPayment?.recipient_name ?? null,
        worker_type: item.workerPayment?.worker_type ?? null,
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
        ? `Payment logged for "${item.label}"`
        : `Problem logged for "${item.label}"`,
      { icon: payload.status === 'paid' ? '✅' : '⚠️' },
    );
    setMarkPaidItem(null);
    // Optimistically remove from list
    setItems((prev) => prev.filter((i) => i.sourceId !== item.sourceId));
  };

  const handleAddWorker = () => {
    setEditingWorker(null);
    setWorkerDialogOpen(true);
  };

  const handleEditWorker = (item: OrphanagePendingItem) => {
    setEditingWorker(item);
    setWorkerDialogOpen(true);
  };

  const handleDeleteWorker = async (item: OrphanagePendingItem) => {
    if (!window.confirm(`Remove the payment for "${item.workerPayment?.recipient_name ?? item.label}"?`)) return;
    const res = await fetch(`/api/orphanage-worker-payments?id=${encodeURIComponent(item.sourceId)}`, {
      method: 'DELETE',
    });
    const json = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || json.error) {
      toast.error(json.error ?? 'Could not remove payment');
      return;
    }
    toast.success('Payment removed');
    setItems((prev) => prev.filter((i) => i.sourceId !== item.sourceId));
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-red-500 to-rose-600 text-white shadow-lg shadow-rose-500/30">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">Couldn&apos;t load orphanage queue</h2>
        <p className="max-w-sm text-xs text-zinc-500 dark:text-zinc-400">{error}</p>
        <Button size="sm" variant="outline" onClick={() => fetchItems()}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-[#ececec] bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h1 className="text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
              Orphanage payments
            </h1>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
              Approved budget requests, gift purchases, and staff (carpenters &amp; musicians) awaiting transfer.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {items.length > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-teal-100 px-2.5 py-1 text-[11px] font-semibold text-teal-700 dark:bg-teal-900/30 dark:text-teal-300">
                {items.length} pending
              </span>
            )}
            <Button
              size="sm"
              onClick={handleAddWorker}
              className="h-8 gap-1.5 bg-gradient-to-br from-emerald-500 to-teal-600 px-3 text-xs font-semibold text-white hover:brightness-110"
            >
              <Plus className="h-3.5 w-3.5" />
              Add payment
            </Button>
            <button
              type="button"
              onClick={() => fetchItems()}
              className="flex h-7 w-7 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-500 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-900"
              title="Refresh"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] px-4 py-4 sm:px-6 sm:py-6 dark:bg-[#0d1117]">
        {items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-400 to-emerald-500 text-white shadow-lg shadow-teal-500/30">
              <Heart className="h-7 w-7" fill="currentColor" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">All caught up!</h2>
              <p className="mt-1 max-w-xs text-xs text-zinc-500 dark:text-zinc-400">
                No pending orphanage payments. Approved budget requests and gifts appear here automatically —
                or use <span className="font-semibold text-emerald-600 dark:text-emerald-400">Add payment</span> to
                pay a carpenter, handyman, or musician.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {/* Budget requests section */}
            {budgetItems.length > 0 && (
              <section>
                <h2 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                  <Banknote className="h-3.5 w-3.5 text-teal-500" />
                  Budget Requests
                  <span className="ml-1 rounded-full bg-teal-100 px-1.5 py-0.5 text-[10px] font-bold text-teal-700 dark:bg-teal-900/30 dark:text-teal-300">
                    {budgetItems.length}
                  </span>
                </h2>
                <AnimatePresence mode="popLayout">
                  <div className="flex flex-col gap-3">
                    {pagedBudgetItems.map((item) => (
                      <OrphanageItemCard key={item.sourceId} item={item} onMarkPaid={setMarkPaidItem} />
                    ))}
                  </div>
                </AnimatePresence>
                <QueuePagination
                  page={budgetPage}
                  pageCount={budgetPageCount}
                  total={budgetItems.length}
                  pageSize={PAGE_SIZE}
                  onPageChange={setBudgetPage}
                  label="requests"
                  className="mt-2 border-0"
                />
              </section>
            )}

            {/* Gift shipping section */}
            {giftItems.length > 0 && (
              <section>
                <h2 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                  <Gift className="h-3.5 w-3.5 text-pink-500" />
                  Gift Purchases
                  <span className="ml-1 rounded-full bg-pink-100 px-1.5 py-0.5 text-[10px] font-bold text-pink-700 dark:bg-pink-900/30 dark:text-pink-300">
                    {giftItems.length}
                  </span>
                </h2>
                <AnimatePresence mode="popLayout">
                  <div className="flex flex-col gap-3">
                    {pagedGiftItems.map((item) => (
                      <OrphanageItemCard key={item.sourceId} item={item} onMarkPaid={setMarkPaidItem} />
                    ))}
                  </div>
                </AnimatePresence>
                <QueuePagination
                  page={giftPage}
                  pageCount={giftPageCount}
                  total={giftItems.length}
                  pageSize={PAGE_SIZE}
                  onPageChange={setGiftPage}
                  label="gifts"
                  className="mt-2 border-0"
                />
              </section>
            )}

            {/* Orphanage staff (carpenters / handymen / musicians) */}
            {workerItems.length > 0 && (
              <section>
                <h2 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                  <Hammer className="h-3.5 w-3.5 text-emerald-500" />
                  Orphanage Staff
                  <span className="ml-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                    {workerItems.length}
                  </span>
                </h2>
                <AnimatePresence mode="popLayout">
                  <div className="flex flex-col gap-3">
                    {pagedWorkerItems.map((item) => (
                      <OrphanageItemCard
                        key={item.sourceId}
                        item={item}
                        onMarkPaid={setMarkPaidItem}
                        onEdit={handleEditWorker}
                        onDelete={handleDeleteWorker}
                      />
                    ))}
                  </div>
                </AnimatePresence>
                <QueuePagination
                  page={workerPage}
                  pageCount={workerPageCount}
                  total={workerItems.length}
                  pageSize={PAGE_SIZE}
                  onPageChange={setWorkerPage}
                  label="staff"
                  className="mt-2 border-0"
                />
              </section>
            )}

            {/* Interns — accepted intern weeks from the Payroll Wizard → Interns view.
                One item per intern share (+ one per orphanage share under
                system_split). No edit / delete: the numbers are the locked week's,
                and the bank is the profile's — both change on the Orphanage side. */}
            {internItems.length > 0 && (
              <section>
                <h2 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                  <GraduationCap className="h-3.5 w-3.5 text-violet-500" />
                  Interns
                  <span className="ml-1 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                    {internItems.length}
                  </span>
                </h2>
                <AnimatePresence mode="popLayout">
                  <div className="flex flex-col gap-3">
                    {pagedInternItems.map((item) => (
                      <OrphanageItemCard
                        key={`${item.sourceType}:${item.sourceId}`}
                        item={item}
                        onMarkPaid={setMarkPaidItem}
                      />
                    ))}
                  </div>
                </AnimatePresence>
                <QueuePagination
                  page={internPage}
                  pageCount={internPageCount}
                  total={internItems.length}
                  pageSize={PAGE_SIZE}
                  onPageChange={setInternPage}
                  label="intern items"
                  className="mt-2 border-0"
                />
              </section>
            )}
          </div>
        )}
      </div>

      <OrphanageMarkPaidDialog
        item={markPaidItem}
        onClose={() => setMarkPaidItem(null)}
        onConfirm={handleConfirmPaid}
      />

      <OrphanageWorkerPaymentDialog
        open={workerDialogOpen}
        editing={editingWorker?.workerPayment ?? null}
        onClose={() => { setWorkerDialogOpen(false); setEditingWorker(null); }}
        onSaved={() => { void fetchItems({ silent: true }); }}
      />
    </div>
  );
}
