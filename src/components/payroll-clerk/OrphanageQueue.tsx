'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from 'next-auth/react';
import { motion, AnimatePresence } from 'motion/react';
import {
  AlertTriangle,
  Banknote,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Gift,
  Heart,
  Loader2,
  MapPin,
  Phone,
  RefreshCw,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { OrphanagePendingItem } from '@/lib/supabase/orphanage-dispatches';

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

// ─── Mark-Paid dialog ───────────────────────────────────────────────────────

interface MarkPaidDialogProps {
  item: OrphanagePendingItem | null;
  onClose: () => void;
  onConfirm: (item: OrphanagePendingItem, payload: MarkPaidPayload) => Promise<void>;
}

interface MarkPaidPayload {
  bankName: string;
  bankAccountName: string;
  bankAccountNumber: string;
  swiftCode: string;
  transactionId: string;
  bankUsed: string;
  sentDate: string;
  note: string;
  status: 'paid' | 'problem';
}

function OrphanageMarkPaidDialog({ item, onClose, onConfirm }: MarkPaidDialogProps) {
  const [bankName, setBankName] = useState('');
  const [bankAccountName, setBankAccountName] = useState('');
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [swiftCode, setSwiftCode] = useState('');
  const [transactionId, setTransactionId] = useState('');
  const [bankUsed, setBankUsed] = useState('');
  const [sentDate, setSentDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  // Pre-fill bank info from item when it opens
  useEffect(() => {
    if (!item) return;
    setBankName(item.bankName);
    setBankAccountName(item.bankAccountName);
    setBankAccountNumber(item.bankAccountNumber);
    setSwiftCode(item.swiftCode);
    setTransactionId('');
    setBankUsed('');
    setSentDate(new Date().toISOString().slice(0, 10));
    setNote('');
  }, [item]);

  const handleConfirm = async (status: 'paid' | 'problem') => {
    if (!item) return;
    if (!transactionId.trim()) {
      toast.error('Transaction ID is required.');
      return;
    }
    setSaving(true);
    try {
      await onConfirm(item, {
        bankName: bankName.trim(),
        bankAccountName: bankAccountName.trim(),
        bankAccountNumber: bankAccountNumber.trim(),
        swiftCode: swiftCode.trim(),
        transactionId: transactionId.trim(),
        bankUsed: bankUsed.trim(),
        sentDate,
        note: note.trim(),
        status,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!item} onOpenChange={(o) => !saving && !o && onClose()}>
      <DialogContent className="max-w-[520px] overflow-hidden p-0">
        {/* Header */}
        <div className="bg-gradient-to-br from-teal-500 to-emerald-600 px-6 py-5 text-white">
          <div className="flex items-center justify-between">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/20 backdrop-blur-sm">
              {item?.sourceType === 'gift_shipping' ? (
                <Gift className="h-5 w-5" />
              ) : (
                <Banknote className="h-5 w-5" />
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-full p-1 hover:bg-white/20 disabled:opacity-50"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <DialogHeader className="mt-3 text-left">
            <DialogTitle className="text-white">Log Orphanage Payment</DialogTitle>
            <DialogDescription className="text-white/80">
              {item?.label ?? '—'} · {formatPHP(item?.amountPhp)}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="space-y-5 px-6 py-5">
          {/* Bank details (editable, pre-filled from source) */}
          <section>
            <h4 className="mb-2.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-teal-700 dark:text-teal-400">
              <Building2 className="h-3.5 w-3.5" /> Destination bank
            </h4>
            <div className="grid gap-3 rounded-xl border border-teal-100 bg-teal-50/60 p-3.5 dark:border-teal-900/30 dark:bg-teal-950/20">
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1">
                  <Label className="text-xs">Bank name</Label>
                  <Input value={bankName} onChange={(e) => setBankName(e.target.value)}
                    placeholder="e.g. BDO Unibank" disabled={saving}
                    className="h-8 text-xs" />
                </div>
                <div className="grid gap-1">
                  <Label className="text-xs">SWIFT / routing code</Label>
                  <Input value={swiftCode} onChange={(e) => setSwiftCode(e.target.value)}
                    placeholder="e.g. BNORPHMM" disabled={saving}
                    className="h-8 text-xs" />
                </div>
              </div>
              <div className="grid gap-1">
                <Label className="text-xs">Account holder name</Label>
                <Input value={bankAccountName} onChange={(e) => setBankAccountName(e.target.value)}
                  placeholder="e.g. Jane Smith" disabled={saving}
                  className="h-8 text-xs" />
              </div>
              <div className="grid gap-1">
                <Label className="text-xs">Account number</Label>
                <Input value={bankAccountNumber} onChange={(e) => setBankAccountNumber(e.target.value)}
                  placeholder="e.g. 1234-5678-9012" disabled={saving}
                  className="h-8 text-xs" />
              </div>
            </div>
          </section>

          {/* Payment details */}
          <section>
            <h4 className="mb-2.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-teal-700 dark:text-teal-400">
              <CheckCircle2 className="h-3.5 w-3.5" /> Payment details
            </h4>
            <div className="grid gap-3 rounded-xl border border-zinc-100 bg-white p-3.5 dark:border-zinc-800 dark:bg-zinc-950/60">
              <div className="grid gap-1">
                <Label className="text-xs">Transaction ID <span className="text-rose-500">*</span></Label>
                <Input value={transactionId} onChange={(e) => setTransactionId(e.target.value)}
                  placeholder="Reference / confirmation number" disabled={saving}
                  className="h-8 text-xs" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1">
                  <Label className="text-xs">Sent from (your bank)</Label>
                  <Input value={bankUsed} onChange={(e) => setBankUsed(e.target.value)}
                    placeholder="e.g. BPI, Metrobank" disabled={saving}
                    className="h-8 text-xs" />
                </div>
                <div className="grid gap-1">
                  <Label className="text-xs">Sent date</Label>
                  <Input type="date" value={sentDate} onChange={(e) => setSentDate(e.target.value)}
                    disabled={saving} className="h-8 text-xs" />
                </div>
              </div>
              <div className="grid gap-1">
                <Label className="text-xs">Note <span className="font-normal text-zinc-400">· optional</span></Label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Anything else worth noting…"
                  disabled={saving}
                  className="min-h-[60px] w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs shadow-sm placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-teal-400/60 disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-950"
                />
              </div>
            </div>
          </section>
        </div>

        <DialogFooter className="gap-2 border-t border-zinc-100 bg-zinc-50/80 px-6 py-3.5 dark:border-zinc-800 dark:bg-zinc-950/60">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button
            variant="outline"
            onClick={() => handleConfirm('problem')}
            disabled={saving}
            className="border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300"
          >
            {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <AlertTriangle className="mr-1.5 h-3.5 w-3.5" />}
            Log problem
          </Button>
          <Button
            onClick={() => handleConfirm('paid')}
            disabled={saving}
            className="bg-gradient-to-br from-teal-500 to-emerald-600 text-white shadow-sm hover:brightness-110"
          >
            {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />}
            Mark paid
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Item card ──────────────────────────────────────────────────────────────

function OrphanageItemCard({
  item,
  onMarkPaid,
}: {
  item: OrphanagePendingItem;
  onMarkPaid: (item: OrphanagePendingItem) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const br = item.budgetRequest;
  const gs = item.giftShipping;

  const isBudget = item.sourceType === 'budget_request';
  const accentClass = isBudget
    ? 'border-teal-200/80 dark:border-teal-900/40'
    : 'border-pink-200/80 dark:border-pink-900/40';
  const badgeClass = isBudget
    ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300'
    : 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300';

  const hasBankInfo = item.bankName || item.bankAccountNumber;

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
              {isBudget ? 'Budget Request' : 'Gift'}
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
          </p>

          {/* Budget request extra info */}
          {br && br.notes && (
            <p className="mt-1 text-[11px] italic text-zinc-500 dark:text-zinc-400">
              &ldquo;{br.notes}&rdquo;
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

          {!hasBankInfo && item.sourceType === 'gift_shipping' && (
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
              isBudget
                ? 'bg-gradient-to-br from-teal-500 to-emerald-600 hover:brightness-110'
                : 'bg-gradient-to-br from-pink-500 to-rose-600 hover:brightness-110',
            )}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Mark paid
          </Button>
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

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/orphanage-dispatches?pending=1', { cache: 'no-store' });
      const json = (await res.json()) as { items?: OrphanagePendingItem[]; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to load');
      setItems(json.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load orphanage queue');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchItems(); }, [fetchItems]);

  const budgetItems = useMemo(() => items.filter((i) => i.sourceType === 'budget_request'), [items]);
  const giftItems = useMemo(() => items.filter((i) => i.sourceType === 'gift_shipping'), [items]);

  const handleConfirmPaid = async (item: OrphanagePendingItem, payload: MarkPaidPayload) => {
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
        ? `Payment logged for "${item.label}"`
        : `Problem logged for "${item.label}"`,
      { icon: payload.status === 'paid' ? '✅' : '⚠️' },
    );
    setMarkPaidItem(null);
    // Optimistically remove from list
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
        <Button size="sm" variant="outline" onClick={fetchItems}>
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
              Approved budget requests and gift purchases awaiting transfer.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {items.length > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-teal-100 px-2.5 py-1 text-[11px] font-semibold text-teal-700 dark:bg-teal-900/30 dark:text-teal-300">
                {items.length} pending
              </span>
            )}
            <button
              type="button"
              onClick={fetchItems}
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
                No pending orphanage payments. Approved budget requests and gifts will appear here.
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
                    {budgetItems.map((item) => (
                      <OrphanageItemCard key={item.sourceId} item={item} onMarkPaid={setMarkPaidItem} />
                    ))}
                  </div>
                </AnimatePresence>
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
                    {giftItems.map((item) => (
                      <OrphanageItemCard key={item.sourceId} item={item} onMarkPaid={setMarkPaidItem} />
                    ))}
                  </div>
                </AnimatePresence>
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
    </div>
  );
}
