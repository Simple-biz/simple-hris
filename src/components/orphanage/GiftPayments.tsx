'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Building2,
  ChevronDown,
  Loader2,
  Plus,
  Receipt,
  Save,
  Trash2,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type LineItem = {
  id: string;
  name: string;
  quantity: number;
  unit_price: number;
};

type PaymentStatus = 'paid' | 'pending' | 'sent' | 'cancelled';

type VendorBank = {
  label: string;
  bank_name: string;
  account_holder: string;
  account_number: string;
  routing_number: string;
  email: string;
};

type Vendor = {
  name: string;
  phone: string;
  email: string;
  street: string;
  city: string;
  province: string;
  postal_code: string;
  full_address: string;
  banks: VendorBank[];
};

type PaymentRecord = {
  id: string;
  period_label: string; // e.g. "April 2026"
  batch_label: string; // e.g. "BATCH 20, 25, 26, 28 & 30"
  vendor: Vendor;
  items: LineItem[];
  shipping_fee: number;
  ordered_by: string;
  total_usd: number;
  transaction_id: string;
  staff: string;
  date_sent: string; // YYYY-MM-DD
  arrival_date: string;
  our_bank: string;
  status: PaymentStatus;
  notes: string;
};

const EMPTY_VENDOR: Vendor = {
  name: '',
  phone: '',
  email: '',
  street: '',
  city: '',
  province: '',
  postal_code: '',
  full_address: '',
  banks: [
    {
      label: 'Bank choice #1',
      bank_name: '',
      account_holder: '',
      account_number: '',
      routing_number: '',
      email: '',
    },
  ],
};

function genId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function newPayment(): PaymentRecord {
  return {
    id: genId(),
    period_label: '',
    batch_label: '',
    vendor: structuredClone(EMPTY_VENDOR),
    items: [],
    shipping_fee: 0,
    ordered_by: '',
    total_usd: 0,
    transaction_id: '',
    staff: '',
    date_sent: '',
    arrival_date: '',
    our_bank: '',
    status: 'pending',
    notes: '',
  };
}

function formatPHP(n: number): string {
  return `₱${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function statusBadgeClass(status: PaymentStatus): string {
  switch (status) {
    case 'paid':
      return 'border-emerald-400/90 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/45 dark:text-emerald-100';
    case 'sent':
      return 'border-sky-400/90 bg-sky-50 text-sky-900 dark:border-sky-700 dark:bg-sky-950/45 dark:text-sky-100';
    case 'pending':
      return 'border-amber-400/90 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/45 dark:text-amber-100';
    default:
      return 'border-rose-400/90 bg-rose-50 text-rose-900 dark:border-rose-700 dark:bg-rose-950/45 dark:text-rose-100';
  }
}

export default function GiftPayments({ viewerEmail }: { viewerEmail?: string | null } = {}) {
  const [records, setRecords] = useState<PaymentRecord[]>([]);
  const [originalJson, setOriginalJson] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (viewerEmail) params.set('email', viewerEmail);
    fetch(`/api/gift-payments?${params.toString()}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((json: { rows?: PaymentRecord[]; error?: string | null }) => {
        if (cancelled) return;
        const rows = (json.rows ?? []).map((r) => ({
          ...r,
          // Defensive: API returns nullable date strings; component fields expect ''.
          date_sent: r.date_sent ?? '',
          arrival_date: r.arrival_date ?? '',
          notes: r.notes ?? '',
        }));
        setRecords(rows);
        setOriginalJson(JSON.stringify({ records: rows }));
      })
      .catch(() => {
        if (!cancelled) {
          setRecords([]);
          setOriginalJson(JSON.stringify({ records: [] }));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [viewerEmail]);

  const dirty = useMemo(
    () => JSON.stringify({ records }) !== originalJson,
    [records, originalJson],
  );

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/gift-payments', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records, created_by: viewerEmail ?? null }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed');
      // Re-fetch so server-assigned IDs/timestamps land in state.
      const params = new URLSearchParams();
      if (viewerEmail) params.set('email', viewerEmail);
      const refresh = await fetch(`/api/gift-payments?${params.toString()}`, { cache: 'no-store' });
      const refreshJson = (await refresh.json()) as { rows?: PaymentRecord[] };
      const rows = (refreshJson.rows ?? []).map((r) => ({
        ...r,
        date_sent: r.date_sent ?? '',
        arrival_date: r.arrival_date ?? '',
        notes: r.notes ?? '',
      }));
      setRecords(rows);
      setOriginalJson(JSON.stringify({ records: rows }));
      toast.success('Payments saved.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save payments');
    } finally {
      setSaving(false);
    }
  }, [records, viewerEmail]);

  const updateRecord = (id: string, patch: Partial<PaymentRecord>) => {
    setRecords((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };
  const updateVendor = (id: string, patch: Partial<Vendor>) => {
    setRecords((rs) =>
      rs.map((r) => (r.id === id ? { ...r, vendor: { ...r.vendor, ...patch } } : r)),
    );
  };
  const updateBank = (recordId: string, bankIdx: number, patch: Partial<VendorBank>) => {
    setRecords((rs) =>
      rs.map((r) =>
        r.id === recordId
          ? {
              ...r,
              vendor: {
                ...r.vendor,
                banks: r.vendor.banks.map((b, i) => (i === bankIdx ? { ...b, ...patch } : b)),
              },
            }
          : r,
      ),
    );
  };
  const addBank = (recordId: string) => {
    setRecords((rs) =>
      rs.map((r) =>
        r.id === recordId
          ? {
              ...r,
              vendor: {
                ...r.vendor,
                banks: [
                  ...r.vendor.banks,
                  {
                    label: `Bank choice #${r.vendor.banks.length + 1}`,
                    bank_name: '',
                    account_holder: '',
                    account_number: '',
                    routing_number: '',
                    email: '',
                  },
                ],
              },
            }
          : r,
      ),
    );
  };
  const removeBank = (recordId: string, bankIdx: number) => {
    setRecords((rs) =>
      rs.map((r) =>
        r.id === recordId
          ? {
              ...r,
              vendor: {
                ...r.vendor,
                banks: r.vendor.banks.filter((_, i) => i !== bankIdx),
              },
            }
          : r,
      ),
    );
  };
  const addItem = (recordId: string) => {
    setRecords((rs) =>
      rs.map((r) =>
        r.id === recordId
          ? {
              ...r,
              items: [...r.items, { id: genId(), name: '', quantity: 0, unit_price: 0 }],
            }
          : r,
      ),
    );
  };
  const updateItem = (recordId: string, itemId: string, patch: Partial<LineItem>) => {
    setRecords((rs) =>
      rs.map((r) =>
        r.id === recordId
          ? {
              ...r,
              items: r.items.map((it) => (it.id === itemId ? { ...it, ...patch } : it)),
            }
          : r,
      ),
    );
  };
  const removeItem = (recordId: string, itemId: string) => {
    setRecords((rs) =>
      rs.map((r) =>
        r.id === recordId ? { ...r, items: r.items.filter((it) => it.id !== itemId) } : r,
      ),
    );
  };

  const addPayment = () => {
    const p = newPayment();
    setRecords((rs) => [p, ...rs]);
    setOpenId(p.id);
  };
  const removePayment = (id: string) => {
    setRecords((rs) => rs.filter((r) => r.id !== id));
    if (openId === id) setOpenId(null);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading payments…
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      className="flex flex-col gap-6"
    >
      {/* Save bar */}
      <div
        className={cn(
          'sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 backdrop-blur-md transition-colors',
          dirty
            ? 'border-orange-300 bg-orange-50/95 dark:border-orange-800/70 dark:bg-orange-950/40'
            : 'border-pink-100/80 bg-white/85 dark:border-pink-950/50 dark:bg-zinc-950/70',
        )}
      >
        <span className="text-xs text-zinc-600 dark:text-zinc-300">
          {dirty ? 'Unsaved changes — click Save to persist.' : 'All changes saved.'}
        </span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8 border-pink-100/70 dark:border-pink-900/50"
            onClick={addPayment}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            New payment
          </Button>
          <Button
            size="sm"
            className="h-8 bg-gradient-to-r from-pink-600 to-rose-700 text-white shadow-sm shadow-pink-600/25 hover:from-pink-700 hover:to-rose-800"
            onClick={() => void save()}
            disabled={!dirty || saving}
          >
            {saving ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="mr-1.5 h-3.5 w-3.5" />
            )}
            Save payments
          </Button>
        </div>
      </div>

      {records.length === 0 ? (
        <div className="rounded-xl border border-dashed border-pink-200/80 bg-white/70 py-10 text-center text-sm text-zinc-600 dark:border-pink-900/50 dark:bg-zinc-950/40 dark:text-zinc-400">
          No payment records yet. Click <b>New payment</b> above to log a vendor batch.
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <AnimatePresence initial={false}>
            {records.map((r) => {
              const isOpen = openId === r.id;
              const itemsTotal = r.items.reduce((s, it) => s + it.quantity * it.unit_price, 0);
              const grandTotal = itemsTotal + (Number(r.shipping_fee) || 0);
              return (
                <motion.div
                  key={r.id}
                  layout
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                >
                  <Card className="overflow-hidden border-pink-100/80 bg-gradient-to-br from-white via-pink-50/30 to-white shadow-md ring-1 ring-pink-500/8 dark:border-pink-950/55 dark:from-zinc-950 dark:via-pink-950/12 dark:to-zinc-950 dark:ring-pink-400/10">
                    {/* Summary row — clickable */}
                    <button
                      type="button"
                      onClick={() => setOpenId(isOpen ? null : r.id)}
                      className="flex w-full items-center gap-4 border-b border-pink-100/60 px-5 py-4 text-left transition-colors hover:bg-pink-50/30 dark:border-pink-900/40 dark:hover:bg-pink-950/20"
                    >
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-pink-600 to-rose-700 text-white shadow-sm shadow-pink-600/25">
                        <Receipt className="h-5 w-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                            {r.vendor.name || 'Untitled vendor'}
                          </span>
                          <span className="text-xs text-zinc-500 dark:text-zinc-400">
                            {r.period_label || '—'}
                            {r.batch_label ? ` · ${r.batch_label}` : ''}
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                          <span className="tabular-nums">{formatPHP(grandTotal)} PHP</span>
                          {r.total_usd ? (
                            <span className="tabular-nums">
                              · ${r.total_usd.toLocaleString(undefined, { minimumFractionDigits: 2 })} USD
                            </span>
                          ) : null}
                          {r.staff ? <span>· {r.staff}</span> : null}
                        </div>
                      </div>
                      <Badge variant="outline" className={cn('text-[10px] font-medium', statusBadgeClass(r.status))}>
                        {r.status.toUpperCase()}
                      </Badge>
                      <motion.div animate={{ rotate: isOpen ? 180 : 0 }} transition={{ duration: 0.2 }}>
                        <ChevronDown className="h-4 w-4 text-zinc-400" />
                      </motion.div>
                    </button>

                    <AnimatePresence initial={false}>
                      {isOpen && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                          className="overflow-hidden"
                        >
                          <CardContent className="grid gap-6 px-5 py-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
                            {/* Vendor panel */}
                            <div className="flex flex-col gap-4">
                              <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 dark:border-amber-900/50 dark:bg-amber-950/25">
                                <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-200">
                                  <Building2 className="h-3.5 w-3.5" />
                                  Vendor profile
                                </div>
                                <div className="grid gap-2">
                                  <FieldRow
                                    label="Name"
                                    value={r.vendor.name}
                                    onChange={(v) => updateVendor(r.id, { name: v })}
                                    placeholder='e.g. Bolado, Bernalyn "Berna"'
                                  />
                                  <FieldRow
                                    label="Phone"
                                    value={r.vendor.phone}
                                    onChange={(v) => updateVendor(r.id, { phone: v })}
                                  />
                                  <FieldRow
                                    label="Email"
                                    value={r.vendor.email}
                                    onChange={(v) => updateVendor(r.id, { email: v })}
                                  />
                                  <FieldRow
                                    label="Street"
                                    value={r.vendor.street}
                                    onChange={(v) => updateVendor(r.id, { street: v })}
                                  />
                                  <FieldRow
                                    label="City"
                                    value={r.vendor.city}
                                    onChange={(v) => updateVendor(r.id, { city: v })}
                                  />
                                  <FieldRow
                                    label="Province"
                                    value={r.vendor.province}
                                    onChange={(v) => updateVendor(r.id, { province: v })}
                                  />
                                  <FieldRow
                                    label="Postal Code"
                                    value={r.vendor.postal_code}
                                    onChange={(v) => updateVendor(r.id, { postal_code: v })}
                                  />
                                  <FieldRow
                                    label="Full Address"
                                    value={r.vendor.full_address}
                                    onChange={(v) => updateVendor(r.id, { full_address: v })}
                                  />
                                </div>
                              </div>

                              {/* Banks */}
                              <div className="flex flex-col gap-3">
                                {r.vendor.banks.map((bank, bIdx) => (
                                  <div
                                    key={bIdx}
                                    className="rounded-xl border border-emerald-200 bg-emerald-50/55 p-4 dark:border-emerald-900/50 dark:bg-emerald-950/25"
                                  >
                                    <div className="mb-2 flex items-center justify-between gap-2">
                                      <Input
                                        value={bank.label}
                                        onChange={(e) =>
                                          updateBank(r.id, bIdx, { label: e.target.value })
                                        }
                                        className="h-7 max-w-[180px] border-zinc-200 text-xs font-semibold dark:border-zinc-700"
                                      />
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7 text-rose-500 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-950/40"
                                        onClick={() => removeBank(r.id, bIdx)}
                                        aria-label="Remove bank"
                                      >
                                        <Trash2 className="h-3.5 w-3.5" />
                                      </Button>
                                    </div>
                                    <div className="grid gap-2">
                                      <FieldRow
                                        label="Bank Name"
                                        value={bank.bank_name}
                                        onChange={(v) =>
                                          updateBank(r.id, bIdx, { bank_name: v })
                                        }
                                      />
                                      <FieldRow
                                        label="Account Holder"
                                        value={bank.account_holder}
                                        onChange={(v) =>
                                          updateBank(r.id, bIdx, { account_holder: v })
                                        }
                                      />
                                      <FieldRow
                                        label="Account #"
                                        value={bank.account_number}
                                        onChange={(v) =>
                                          updateBank(r.id, bIdx, { account_number: v })
                                        }
                                      />
                                      <FieldRow
                                        label="Routing #"
                                        value={bank.routing_number}
                                        onChange={(v) =>
                                          updateBank(r.id, bIdx, { routing_number: v })
                                        }
                                      />
                                      <FieldRow
                                        label="Email"
                                        value={bank.email}
                                        onChange={(v) => updateBank(r.id, bIdx, { email: v })}
                                      />
                                    </div>
                                  </div>
                                ))}
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="self-start border-pink-100/70 dark:border-pink-900/50"
                                  onClick={() => addBank(r.id)}
                                >
                                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                                  Add bank
                                </Button>
                              </div>
                            </div>

                            {/* Right panel — batch + items + payment */}
                            <div className="flex flex-col gap-4">
                              <div className="grid gap-2 sm:grid-cols-2">
                                <FieldRow
                                  label="Period"
                                  value={r.period_label}
                                  onChange={(v) => updateRecord(r.id, { period_label: v })}
                                  placeholder="April 2026"
                                />
                                <FieldRow
                                  label="Batches"
                                  value={r.batch_label}
                                  onChange={(v) => updateRecord(r.id, { batch_label: v })}
                                  placeholder="BATCH 20, 25, 26, 28 & 30"
                                />
                              </div>

                              {/* Items */}
                              <div className="overflow-x-auto rounded-lg border border-pink-100/80 dark:border-pink-900/50">
                                <table className="w-full min-w-[480px] text-left text-sm">
                                  <thead className="bg-gradient-to-r from-pink-50 via-white to-pink-50/80 text-xs text-zinc-600 dark:from-pink-950/40 dark:via-zinc-950 dark:to-pink-950/30 dark:text-zinc-400">
                                    <tr>
                                      <th className="px-3 py-2 font-semibold">Items</th>
                                      <th className="px-3 py-2 font-semibold w-[80px]">Qty</th>
                                      <th className="px-3 py-2 font-semibold w-[100px]">Unit Price</th>
                                      <th className="px-3 py-2 font-semibold w-[110px]">Amount</th>
                                      <th className="px-2 py-2 w-[1%]" />
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-pink-100/60 dark:divide-pink-900/30">
                                    {r.items.map((it) => {
                                      const amt = it.quantity * it.unit_price;
                                      return (
                                        <tr key={it.id} className="align-top hover:bg-pink-50/30 dark:hover:bg-pink-950/20">
                                          <td className="px-2 py-1.5">
                                            <Input
                                              value={it.name}
                                              onChange={(e) =>
                                                updateItem(r.id, it.id, { name: e.target.value })
                                              }
                                              className="h-8 border-zinc-200 text-xs dark:border-zinc-700"
                                              placeholder="Item name"
                                            />
                                          </td>
                                          <td className="px-2 py-1.5">
                                            <Input
                                              type="number"
                                              value={it.quantity}
                                              onChange={(e) =>
                                                updateItem(r.id, it.id, {
                                                  quantity: Number(e.target.value) || 0,
                                                })
                                              }
                                              className="h-8 border-zinc-200 text-xs tabular-nums dark:border-zinc-700"
                                            />
                                          </td>
                                          <td className="px-2 py-1.5">
                                            <Input
                                              type="number"
                                              step="0.01"
                                              value={it.unit_price}
                                              onChange={(e) =>
                                                updateItem(r.id, it.id, {
                                                  unit_price: Number(e.target.value) || 0,
                                                })
                                              }
                                              className="h-8 border-zinc-200 text-xs tabular-nums dark:border-zinc-700"
                                            />
                                          </td>
                                          <td className="px-3 py-1.5 text-xs tabular-nums text-zinc-700 dark:text-zinc-300">
                                            {formatPHP(amt)}
                                          </td>
                                          <td className="px-2 py-1.5">
                                            <Button
                                              variant="ghost"
                                              size="icon"
                                              className="h-7 w-7 text-rose-500 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-950/40"
                                              onClick={() => removeItem(r.id, it.id)}
                                              aria-label="Remove item"
                                            >
                                              <Trash2 className="h-3.5 w-3.5" />
                                            </Button>
                                          </td>
                                        </tr>
                                      );
                                    })}
                                    <tr>
                                      <td colSpan={3} className="px-3 py-1.5 text-right text-xs font-medium text-zinc-600 dark:text-zinc-300">
                                        Shipping fee
                                      </td>
                                      <td className="px-2 py-1.5">
                                        <Input
                                          type="number"
                                          step="0.01"
                                          value={r.shipping_fee}
                                          onChange={(e) =>
                                            updateRecord(r.id, {
                                              shipping_fee: Number(e.target.value) || 0,
                                            })
                                          }
                                          className="h-8 border-zinc-200 text-xs tabular-nums dark:border-zinc-700"
                                        />
                                      </td>
                                      <td />
                                    </tr>
                                    <tr className="bg-pink-50/40 dark:bg-pink-950/25">
                                      <td colSpan={3} className="px-3 py-2 text-right text-xs font-bold text-zinc-800 dark:text-zinc-100">
                                        Grand total
                                      </td>
                                      <td className="px-3 py-2 text-xs font-bold tabular-nums text-zinc-900 dark:text-zinc-100">
                                        {formatPHP(grandTotal)}
                                      </td>
                                      <td />
                                    </tr>
                                  </tbody>
                                </table>
                                <div className="border-t border-pink-100/60 px-3 py-2 dark:border-pink-900/40">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="border-pink-100/70 dark:border-pink-900/50"
                                    onClick={() => addItem(r.id)}
                                  >
                                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                                    Add item
                                  </Button>
                                </div>
                              </div>

                              {/* Payment block */}
                              <div className="rounded-xl border border-pink-200 bg-pink-50/50 p-4 dark:border-pink-900/50 dark:bg-pink-950/25">
                                <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-pink-800 dark:text-pink-200">
                                  <Wallet className="h-3.5 w-3.5" />
                                  Full payment
                                </div>
                                <div className="grid gap-2 sm:grid-cols-2">
                                  <FieldRow
                                    label="Ordered by"
                                    value={r.ordered_by}
                                    onChange={(v) => updateRecord(r.id, { ordered_by: v })}
                                  />
                                  <FieldRow
                                    label="Total USD"
                                    type="number"
                                    value={r.total_usd}
                                    onChange={(v) =>
                                      updateRecord(r.id, { total_usd: Number(v) || 0 })
                                    }
                                  />
                                  <FieldRow
                                    label="Transaction ID"
                                    value={r.transaction_id}
                                    onChange={(v) => updateRecord(r.id, { transaction_id: v })}
                                  />
                                  <FieldRow
                                    label="Staff"
                                    value={r.staff}
                                    onChange={(v) => updateRecord(r.id, { staff: v })}
                                  />
                                  <FieldRow
                                    label="Date Sent"
                                    type="date"
                                    value={r.date_sent}
                                    onChange={(v) => updateRecord(r.id, { date_sent: v })}
                                  />
                                  <FieldRow
                                    label="Arrival Date"
                                    type="date"
                                    value={r.arrival_date}
                                    onChange={(v) => updateRecord(r.id, { arrival_date: v })}
                                  />
                                  <FieldRow
                                    label="Our bank"
                                    value={r.our_bank}
                                    onChange={(v) => updateRecord(r.id, { our_bank: v })}
                                  />
                                  <div className="flex items-center gap-2">
                                    <Label className="w-[120px] shrink-0 text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
                                      Status
                                    </Label>
                                    <select
                                      value={r.status}
                                      onChange={(e) =>
                                        updateRecord(r.id, {
                                          status: e.target.value as PaymentStatus,
                                        })
                                      }
                                      className="h-8 flex-1 rounded-md border border-zinc-200 bg-white px-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                                    >
                                      <option value="pending">Pending</option>
                                      <option value="sent">Sent</option>
                                      <option value="paid">Paid</option>
                                      <option value="cancelled">Cancelled</option>
                                    </select>
                                  </div>
                                </div>
                                <div className="mt-3">
                                  <Label className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
                                    Notes
                                  </Label>
                                  <textarea
                                    value={r.notes}
                                    onChange={(e) => updateRecord(r.id, { notes: e.target.value })}
                                    rows={2}
                                    className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                                  />
                                </div>
                              </div>

                              <div className="flex justify-end">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-950/40"
                                  onClick={() => removePayment(r.id)}
                                >
                                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                                  Delete payment
                                </Button>
                              </div>
                            </div>
                          </CardContent>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </Card>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </motion.div>
  );
}

function FieldRow({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string;
  value: string | number;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Label className="w-[120px] shrink-0 text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
        {label}
      </Label>
      <Input
        value={value}
        type={type}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 flex-1 border-zinc-200 text-xs dark:border-zinc-700"
      />
    </div>
  );
}
