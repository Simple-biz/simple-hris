'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Download,
  FileText,
  Loader2,
  Lock,
  RefreshCw,
  RotateCcw,
  Search,
  ShoppingCart,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { milestoneLabel } from '@/lib/gift-milestones';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import {
  buildInvoice,
  formatPhp,
  ORDER_PROBLEM_LABEL,
  resolveOrderLines,
  type OrderCatalogItem,
  type OrderLine,
  type OrderSubmission,
  type OrderTier,
} from '@/lib/gift-tracker/orders';
import { downloadOrderInvoicePdf, invoiceNumber } from '@/lib/gift-tracker/order-invoice';
import { fetchOrdersState, type OrdersClientState } from '@/lib/gift-tracker/orders-client';
import type { GiftOrderRow } from '@/lib/supabase/gift-orders';
import InvoiceProgress, { type InvoicePhase } from '@/components/orphanage/InvoiceProgress';

/**
 * Gift Tracker → Orders (Kane, 2026-09-23).
 *
 * OPEN: every APPROVED submission no live order holds — any month, the moment it
 * is approved. Pick gifts → the invoice preview prices them from Gift items →
 * **Lock order** writes the invoice (server re-prices it) and downloads the PDF.
 * LOCKED: every invoice ever locked; the PDF is rebuilt from its stored snapshot,
 * and a locked order can be REOPENED (kept, stamped, its gifts back to Open).
 * Governing doc: docs/features/gift-tracker-orders.md.
 */

const PAGE_SIZE = 20;

export interface GiftOrdersPerson {
  name: string;
  department: string | null;
}

interface SubmissionGroup {
  submissionId: string;
  personalEmail: string;
  name: string;
  department: string | null;
  milestoneIndex: number;
  milestoneDate: string;
  shipTo: string;
  decidedAt: string | null;
  lines: OrderLine[];
  ready: boolean;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}
function fmtStamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export default function GiftOrders({
  submissions,
  people,
  onState,
}: {
  /** Every shipping submission the tracker loaded (any status). */
  submissions: OrderSubmission[];
  /** Roster lookup keyed by lower-case personal email. */
  people: Map<string, GiftOrdersPerson>;
  /** Every fresh read is handed up so the tab badge counts from the SAME data;
   *  `null` = unknown (failed read or not migrated) — the badge hides, never 0. */
  onState?: (state: OrdersClientState | null) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [migrated, setMigrated] = useState(true);
  const [orders, setOrders] = useState<GiftOrderRow[]>([]);
  const [liveKeys, setLiveKeys] = useState<Set<string>>(new Set());
  const [catalog, setCatalog] = useState<OrderCatalogItem[]>([]);
  const [tiers, setTiers] = useState<OrderTier[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [variantChoices, setVariantChoices] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [locking, setLocking] = useState(false);
  const [reopenTarget, setReopenTarget] = useState<GiftOrderRow | null>(null);
  const [reopenReason, setReopenReason] = useState('');
  const [reopening, setReopening] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  /** Real lock phases for the "Creating invoice" overlay — see InvoiceProgress. */
  const [lockPhase, setLockPhase] = useState<InvoicePhase | null>(null);
  const [lockedInvoiceNo, setLockedInvoiceNo] = useState<string | null>(null);
  const [lockGiftCount, setLockGiftCount] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<GiftOrderRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const st = await fetchOrdersState();
      setMigrated(st.migrated);
      setOrders(st.orders);
      setLiveKeys(new Set(st.liveKeys));
      setCatalog(st.catalog);
      setTiers(st.tiers);
      setLoadError(null);
      onState?.(st.migrated ? st : null);
    } catch (e) {
      onState?.(null);
      // Never paint an empty Open list over a failed read — that reads as
      // "nothing to order". The error card says what actually happened.
      setLoadError(e instanceof Error ? e.message : 'Could not load orders');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [onState]);

  useEffect(() => {
    void load();
  }, [load]);

  const lines = useMemo(
    () => resolveOrderLines({ submissions, catalog, tiers, lockedKeys: liveKeys, variantChoices }),
    [submissions, catalog, tiers, liveKeys, variantChoices],
  );

  const groups = useMemo<SubmissionGroup[]>(() => {
    const by = new Map<string, SubmissionGroup>();
    for (const l of lines) {
      let g = by.get(l.submissionId);
      if (!g) {
        const person = people.get(l.personalEmail);
        g = {
          submissionId: l.submissionId,
          personalEmail: l.personalEmail,
          name: person?.name ?? l.personalEmail,
          department: person?.department ?? null,
          milestoneIndex: l.milestoneIndex,
          milestoneDate: l.milestoneDate,
          shipTo: l.submission.preferred_delivery_location,
          decidedAt: l.submission.decided_at,
          lines: [],
          ready: true,
        };
        by.set(l.submissionId, g);
      }
      g.lines.push(l);
      if (l.problem !== null) g.ready = false;
    }
    return [...by.values()];
  }, [lines, people]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) =>
      [g.name, g.personalEmail, g.department ?? '', g.shipTo, ...g.lines.map((l) => `${l.item} ${l.size}`)]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [groups, search]);

  useEffect(() => setPage(0), [search]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pageCount - 1);
  const paged = filtered.slice(pageSafe * PAGE_SIZE, (pageSafe + 1) * PAGE_SIZE);

  // A selection only ever holds gifts that are still open AND ready — a gift that
  // gains a problem (catalog edit) or leaves Open (locked elsewhere) drops out.
  const selectedGroups = useMemo(
    () => groups.filter((g) => selected.has(g.submissionId) && g.ready),
    [groups, selected],
  );
  const preview = useMemo(() => {
    if (selectedGroups.length === 0) return null;
    return buildInvoice(
      selectedGroups.flatMap((g) => g.lines),
      (email) => people.get(email)?.name ?? null,
    ).snapshot;
  }, [selectedGroups, people]);

  const readyCount = groups.filter((g) => g.ready).length;
  const blockedCount = groups.length - readyCount;

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const selectAllReady = () => setSelected(new Set(filtered.filter((g) => g.ready).map((g) => g.submissionId)));

  const lock = useCallback(async () => {
    if (!preview || selectedGroups.length === 0) return;
    setLocking(true);
    setLockedInvoiceNo(null);
    setLockGiftCount(preview.giftCount);
    setLockPhase('locking');
    let succeeded = false;
    try {
      const names: Record<string, string> = {};
      for (const g of selectedGroups) names[g.personalEmail] = g.name;
      const res = await fetch('/api/gift-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'lock',
          submissionIds: selectedGroups.map((g) => g.submissionId),
          variantChoices,
          names,
          expectedTotalCentavos: preview.totalCentavos,
        }),
      });
      const json = (await res.json()) as { order?: GiftOrderRow; error?: string | null };
      if (!res.ok || !json.order) throw new Error(json.error ?? 'Could not lock the order');
      const o = json.order;
      setSelected(new Set());
      // The order EXISTS from here on, whatever the PDF does next.
      setLockedInvoiceNo(invoiceNumber(o.order_no));
      setLockPhase('pdf');
      let pdfOk = true;
      try {
        await downloadOrderInvoicePdf(
          { orderNo: o.order_no, lockedAt: o.locked_at, lockedBy: o.locked_by, status: o.status },
          o.snapshot,
        );
      } catch {
        pdfOk = false;
      }
      if (pdfOk) {
        succeeded = true;
        setLockPhase('done');
        toast.success(`${invoiceNumber(o.order_no)} locked — ${formatPhp(o.total_centavos)}.`);
      } else {
        setLockPhase(null);
        toast.error(
          `${invoiceNumber(o.order_no)} is locked, but the PDF could not be built. Download it from Locked orders.`,
        );
      }
      await load();
    } catch (e) {
      setLockPhase(null);
      toast.error(e instanceof Error ? e.message : 'Could not lock the order');
      // A 409 means the screen was stale — reload so it matches the server.
      await load();
    } finally {
      setLocking(false);
      // Hold "ready" long enough for the stamp to land, then close.
      if (succeeded) window.setTimeout(() => setLockPhase(null), 1400);
    }
  }, [preview, selectedGroups, variantChoices, load]);

  const reopen = useCallback(async () => {
    if (!reopenTarget) return;
    setReopening(true);
    try {
      const res = await fetch('/api/gift-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reopen', orderId: reopenTarget.id, reason: reopenReason }),
      });
      const json = (await res.json()) as { error?: string | null };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Could not reopen');
      toast.success(`${invoiceNumber(reopenTarget.order_no)} reopened — its gifts are back in Open orders.`);
      setReopenTarget(null);
      setReopenReason('');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not reopen');
    } finally {
      setReopening(false);
    }
  }, [reopenTarget, reopenReason, load]);

  const remove = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch('/api/gift-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', orderId: deleteTarget.id }),
      });
      const json = (await res.json()) as { error?: string | null };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Could not delete');
      toast.success(
        deleteTarget.status === 'locked'
          ? `${invoiceNumber(deleteTarget.order_no)} deleted — its gifts are back in Open orders.`
          : `${invoiceNumber(deleteTarget.order_no)} deleted.`,
      );
      setDeleteTarget(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete');
      await load();
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, load]);

  const download = useCallback(async (o: GiftOrderRow) => {
    setDownloadingId(o.id);
    try {
      await downloadOrderInvoicePdf(
        {
          orderNo: o.order_no,
          lockedAt: o.locked_at,
          lockedBy: o.locked_by,
          status: o.status,
          reopenedAt: o.reopened_at,
          reopenedBy: o.reopened_by,
        },
        o.snapshot,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not build the PDF');
    } finally {
      setDownloadingId(null);
    }
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading orders…
      </div>
    );
  }

  if (!migrated) {
    return (
      <Card className="border-amber-300 bg-amber-50/70 dark:border-amber-900/60 dark:bg-amber-950/30">
        <CardContent className="flex items-start gap-3 py-6 text-sm text-amber-900 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-semibold">Orders are not set up yet.</p>
            <p className="mt-1 text-xs">
              The Gift Orders database tables have not been created. Run{' '}
              <code className="rounded bg-amber-100 px-1 dark:bg-amber-900/50">scripts/Apply Gift Orders migration.cmd</code>,
              then refresh.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (loadError) {
    return (
      <Card className="border-rose-300 bg-rose-50/70 dark:border-rose-900/60 dark:bg-rose-950/30">
        <CardContent className="flex items-center justify-between gap-3 py-6 text-sm text-rose-900 dark:text-rose-200">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> {loadError}
          </span>
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={refreshing}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <InvoiceProgress phase={lockPhase} invoiceNo={lockedInvoiceNo} giftCount={lockGiftCount} />
      {/* ── Open orders ─────────────────────────────────────────────────── */}
      <Card className="overflow-hidden ring-1 ring-emerald-200/60 dark:ring-emerald-900/40">
        <CardHeader className="flex flex-col gap-3 border-b border-emerald-100/60 pb-4 dark:border-emerald-900/40">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-sm shadow-emerald-500/25">
                <ShoppingCart className="h-4 w-4" />
              </div>
              <div>
                <CardTitle className="text-base font-semibold">Open orders</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Every approved gift not on a locked order yet. {readyCount} ready
                  {blockedCount > 0 && (
                    <span className="text-amber-700 dark:text-amber-400"> · {blockedCount} need attention</span>
                  )}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name, item, address…"
                  className="h-8 w-56 pl-8 text-xs"
                />
              </div>
              <Button size="sm" variant="outline" className="h-8" onClick={selectAllReady} disabled={readyCount === 0}>
                Select all ready
              </Button>
              {selected.size > 0 && (
                <Button size="sm" variant="ghost" className="h-8" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
              )}
              <Button size="sm" variant="outline" className="h-8" onClick={() => void load()} disabled={refreshing}>
                <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', refreshing && 'animate-spin')} />
                Refresh
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <p className="px-6 py-14 text-center text-sm text-zinc-500 dark:text-zinc-400">
              {groups.length === 0
                ? 'No open orders. Approved gifts land here the moment they are approved.'
                : 'No open orders match your search.'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead className="bg-emerald-50/70 text-xs text-emerald-900/80 dark:bg-emerald-950/30 dark:text-emerald-200/80">
                  <tr>
                    <th className="w-10 px-3 py-2" />
                    <th className="px-3 py-2 font-semibold">Employee</th>
                    <th className="px-3 py-2 font-semibold">Milestone</th>
                    <th className="px-3 py-2 font-semibold">Gift · size · price</th>
                    <th className="px-3 py-2 font-semibold">Ship to</th>
                    <th className="px-3 py-2 font-semibold">Approved</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-emerald-100/70 dark:divide-emerald-900/35">
                  {paged.map((g) => {
                    const checked = selected.has(g.submissionId) && g.ready;
                    return (
                      <tr
                        key={g.submissionId}
                        className={cn('align-top', checked && 'bg-emerald-50/60 dark:bg-emerald-950/25')}
                      >
                        <td className="px-3 py-2.5">
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-emerald-600"
                            checked={checked}
                            disabled={!g.ready}
                            onChange={() => toggle(g.submissionId)}
                            aria-label={`Add ${g.name} to the order`}
                            title={g.ready ? undefined : 'Fix the flagged line first'}
                          />
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="font-medium text-zinc-900 dark:text-zinc-100">{g.name}</div>
                          <div className="text-[11px] text-zinc-500">
                            {g.department ? formatDeptLabel(g.department) : g.personalEmail}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-xs">
                          <div className="font-medium">{milestoneLabel(g.milestoneIndex)}</div>
                          <div className="text-zinc-500">{fmtDate(g.milestoneDate)}</div>
                        </td>
                        <td className="px-3 py-2.5">
                          <ul className="flex flex-col gap-1.5">
                            {g.lines.map((l) => (
                              <li key={l.key} className="flex flex-wrap items-center gap-1.5 text-xs">
                                <span className="font-medium">{l.item}</span>
                                {l.size && (
                                  <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                                    {l.size}
                                  </Badge>
                                )}
                                {l.unitCentavos !== null && l.problem === null && (
                                  <span className="tabular-nums text-zinc-600 dark:text-zinc-400">
                                    {formatPhp(l.unitCentavos)}
                                  </span>
                                )}
                                {l.variantOptions.length > 0 && (
                                  <select
                                    className="h-6 rounded border border-zinc-200 bg-transparent px-1 text-[11px] dark:border-zinc-700"
                                    value={variantChoices[l.key] ?? l.catalogItemId ?? ''}
                                    onChange={(e) =>
                                      setVariantChoices((v) => ({ ...v, [l.key]: e.target.value }))
                                    }
                                    aria-label={`Which ${l.item}`}
                                  >
                                    <option value="" disabled>
                                      Pick which…
                                    </option>
                                    {l.variantOptions.map((o) => (
                                      <option key={o.id} value={o.id}>
                                        {o.description || o.item} — {o.price_php > 0 ? `₱${o.price_php}` : 'no price'}
                                      </option>
                                    ))}
                                  </select>
                                )}
                                {l.problem && (
                                  <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
                                    <AlertTriangle className="h-3 w-3" />
                                    {ORDER_PROBLEM_LABEL[l.problem]}
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </td>
                        <td className="max-w-[240px] px-3 py-2.5 text-xs text-zinc-600 dark:text-zinc-400">
                          {g.shipTo || <span className="italic text-zinc-400">No address</span>}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-zinc-500">{fmtDate(g.decidedAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {filtered.length > PAGE_SIZE && (
            <div className="flex items-center justify-between border-t border-emerald-100/60 bg-white/70 px-4 py-3 dark:border-emerald-900/40 dark:bg-zinc-950/40">
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                Page {pageSafe + 1} of {pageCount} · {filtered.length} open
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="h-7 px-3 text-xs" disabled={pageSafe === 0} onClick={() => setPage(pageSafe - 1)}>
                  ← Prev
                </Button>
                <Button variant="outline" size="sm" className="h-7 px-3 text-xs" disabled={pageSafe >= pageCount - 1} onClick={() => setPage(pageSafe + 1)}>
                  Next →
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Invoice preview + lock ─────────────────────────────────────── */}
      {preview && (
        <Card className="overflow-hidden ring-1 ring-emerald-300/70 dark:ring-emerald-800/60">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 border-b border-emerald-100/60 pb-4 dark:border-emerald-900/40">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-blue-700 text-white shadow-sm">
                <FileText className="h-4 w-4" />
              </div>
              <div>
                <CardTitle className="text-base font-semibold">Invoice preview</CardTitle>
                <p className="text-xs text-muted-foreground">
                  {preview.giftCount} gift{preview.giftCount === 1 ? '' : 's'} · {preview.qtyTotal} item
                  {preview.qtyTotal === 1 ? '' : 's'} · prices from Gift items, frozen when you lock
                </p>
              </div>
            </div>
            <Button
              size="sm"
              className="h-9 bg-gradient-to-r from-emerald-600 to-teal-700 text-white shadow-sm hover:from-emerald-700 hover:to-teal-800"
              onClick={() => void lock()}
              disabled={locking}
            >
              {locking ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Lock className="mr-1.5 h-4 w-4" />}
              Lock order &amp; build PDF
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-left text-sm">
              <thead className="bg-zinc-50 text-xs text-zinc-600 dark:bg-zinc-900/60 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-2 font-semibold">Item</th>
                  <th className="px-4 py-2 font-semibold">Size</th>
                  <th className="px-4 py-2 text-right font-semibold">Qty</th>
                  <th className="px-4 py-2 text-right font-semibold">Unit price</th>
                  <th className="px-4 py-2 text-right font-semibold">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {preview.groups.map((g) => (
                  <tr key={`${g.item}|${g.size}|${g.unitCentavos}`}>
                    <td className="px-4 py-2">{g.item}</td>
                    <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">{g.size || '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{g.qty}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatPhp(g.unitCentavos)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatPhp(g.amountCentavos)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-emerald-50/80 font-semibold dark:bg-emerald-950/30">
                  <td className="px-4 py-2.5" colSpan={2}>
                    Total
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{preview.qtyTotal}</td>
                  <td />
                  <td className="px-4 py-2.5 text-right tabular-nums text-emerald-700 dark:text-emerald-300">
                    {formatPhp(preview.totalCentavos)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </CardContent>
        </Card>
      )}

      {/* ── Locked orders ──────────────────────────────────────────────── */}
      <Card className="overflow-hidden ring-1 ring-zinc-200/70 dark:ring-zinc-800">
        <CardHeader className="border-b border-zinc-100 pb-4 dark:border-zinc-800">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-zinc-600 to-zinc-800 text-white shadow-sm">
              <Lock className="h-4 w-4" />
            </div>
            <div>
              <CardTitle className="text-base font-semibold">Locked orders</CardTitle>
              <p className="text-xs text-muted-foreground">
                Every invoice locked and not deleted. The PDF prints exactly what was locked. Reopen keeps the
                invoice (marked reopened) and sends its gifts back to Open; Delete removes it for good.
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {orders.length === 0 ? (
            <p className="px-6 py-10 text-center text-sm text-zinc-500">No orders locked yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="bg-zinc-50 text-xs text-zinc-600 dark:bg-zinc-900/60 dark:text-zinc-400">
                  <tr>
                    <th className="px-4 py-2 font-semibold">Invoice</th>
                    <th className="px-4 py-2 font-semibold">Locked</th>
                    <th className="px-4 py-2 text-right font-semibold">Gifts</th>
                    <th className="px-4 py-2 text-right font-semibold">Items</th>
                    <th className="px-4 py-2 text-right font-semibold">Total</th>
                    <th className="px-4 py-2 font-semibold">Status</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {orders.map((o) => (
                    <tr key={o.id} className={cn(o.status === 'reopened' && 'text-zinc-500')}>
                      <td className="px-4 py-2.5 font-mono text-xs font-semibold">{invoiceNumber(o.order_no)}</td>
                      <td className="px-4 py-2.5 text-xs">
                        <div>{fmtStamp(o.locked_at)}</div>
                        <div className="text-zinc-500">{o.locked_by}</div>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{o.snapshot?.giftCount ?? '—'}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{o.snapshot?.qtyTotal ?? o.line_count}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-medium">{formatPhp(o.total_centavos)}</td>
                      <td className="px-4 py-2.5 text-xs">
                        {o.status === 'locked' ? (
                          <Badge className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-300">
                            <Lock className="mr-1 h-2.5 w-2.5" /> Locked
                          </Badge>
                        ) : (
                          <div>
                            <Badge className="border-rose-500/30 bg-rose-500/10 text-[10px] text-rose-700 dark:text-rose-300">
                              Reopened
                            </Badge>
                            <div className="mt-1 text-[11px] text-zinc-500">
                              {fmtStamp(o.reopened_at)} · {o.reopened_by}
                              {o.reopen_reason && <> · “{o.reopen_reason}”</>}
                            </div>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex justify-end gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => void download(o)}
                            disabled={downloadingId === o.id}
                          >
                            {downloadingId === o.id ? (
                              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                            ) : (
                              <Download className="mr-1 h-3 w-3" />
                            )}
                            PDF
                          </Button>
                          {o.status === 'locked' && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 border-rose-200 text-xs text-rose-700 hover:bg-rose-50 dark:border-rose-900/50 dark:text-rose-300"
                              onClick={() => {
                                setReopenTarget(o);
                                setReopenReason('');
                                setDeleteTarget(null);
                              }}
                            >
                              <RotateCcw className="mr-1 h-3 w-3" />
                              Reopen
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0 text-rose-500 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-950/40"
                            onClick={() => {
                              setDeleteTarget(o);
                              setReopenTarget(null);
                            }}
                            aria-label={`Delete ${invoiceNumber(o.order_no)}`}
                            title="Delete this invoice"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        {deleteTarget?.id === o.id && (
                          <div className="mt-2 flex flex-col gap-2 rounded-md border border-rose-300 bg-rose-50 p-2.5 text-xs dark:border-rose-900/60 dark:bg-rose-950/40">
                            <span className="text-rose-900 dark:text-rose-200">
                              <strong>Delete {invoiceNumber(o.order_no)} for good?</strong>{' '}
                              {o.status === 'locked'
                                ? `Its ${o.snapshot?.giftCount ?? ''} gifts go back to Open orders. `
                                : 'It is already reopened, so no gifts move. '}
                              If the PDF already went to the vendor, their copy no longer matches anything here.
                              A full copy is kept in the audit log.
                            </span>
                            <div className="flex justify-end gap-1.5">
                              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setDeleteTarget(null)} disabled={deleting}>
                                Cancel
                              </Button>
                              <Button
                                size="sm"
                                className="h-7 bg-rose-600 text-xs text-white hover:bg-rose-700"
                                onClick={() => void remove()}
                                disabled={deleting}
                              >
                                {deleting ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Trash2 className="mr-1 h-3 w-3" />}
                                Delete invoice
                              </Button>
                            </div>
                          </div>
                        )}
                        {reopenTarget?.id === o.id && (
                          <div className="mt-2 flex flex-col gap-2 rounded-md border border-rose-200 bg-rose-50/70 p-2.5 text-xs dark:border-rose-900/50 dark:bg-rose-950/30">
                            <span className="text-rose-900 dark:text-rose-200">
                              Reopen {invoiceNumber(o.order_no)}? The invoice is kept and marked reopened; its{' '}
                              {o.snapshot?.giftCount ?? ''} gifts go back to Open orders.
                            </span>
                            <Input
                              value={reopenReason}
                              onChange={(e) => setReopenReason(e.target.value)}
                              placeholder="Reason (optional)"
                              className="h-7 text-xs"
                            />
                            <div className="flex justify-end gap-1.5">
                              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setReopenTarget(null)} disabled={reopening}>
                                Cancel
                              </Button>
                              <Button
                                size="sm"
                                className="h-7 bg-rose-600 text-xs text-white hover:bg-rose-700"
                                onClick={() => void reopen()}
                                disabled={reopening}
                              >
                                {reopening && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                                Reopen order
                              </Button>
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
