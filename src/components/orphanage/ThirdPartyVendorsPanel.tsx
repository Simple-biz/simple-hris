'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Banknote,
  Building2,
  CheckCircle2,
  Clock,
  Eye,
  FileText,
  Loader2,
  Mail,
  MapPin,
  Package,
  Pencil,
  Phone,
  Plus,
  Printer,
  Receipt,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import VendorDialog from './VendorDialog';
import VendorInvoiceBuilderDialog from './VendorInvoiceBuilderDialog';
import VendorInvoiceMarkPaidDialog, { type VendorInvoicePaidPayload } from './VendorInvoiceMarkPaidDialog';
import VendorInvoiceDocument, { printInvoice } from './VendorInvoiceDocument';
import {
  formatVendorPHP,
  vendorHasBanking,
  type OrphanageVendorInvoiceRow,
  type OrphanageVendorRow,
} from '@/lib/orphanage/vendor';

type SubTab = 'vendors' | 'invoices';

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export default function ThirdPartyVendorsPanel({ viewerEmail }: { viewerEmail: string | null }) {
  const [subTab, setSubTab] = useState<SubTab>('invoices');

  const [vendors, setVendors] = useState<OrphanageVendorRow[]>([]);
  const [invoices, setInvoices] = useState<OrphanageVendorInvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [vendorDialogOpen, setVendorDialogOpen] = useState(false);
  const [editingVendor, setEditingVendor] = useState<OrphanageVendorRow | null>(null);
  const [invoiceDialogOpen, setInvoiceDialogOpen] = useState(false);
  const [editingInvoice, setEditingInvoice] = useState<OrphanageVendorInvoiceRow | null>(null);
  const [markPaidInvoice, setMarkPaidInvoice] = useState<OrphanageVendorInvoiceRow | null>(null);
  const [previewInvoice, setPreviewInvoice] = useState<OrphanageVendorInvoiceRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [vRes, iRes] = await Promise.all([
        fetch('/api/orphanage-vendors', { cache: 'no-store' }),
        fetch('/api/orphanage-vendor-invoices', { cache: 'no-store' }),
      ]);
      const vJson = (await vRes.json()) as { rows?: OrphanageVendorRow[]; error?: string };
      const iJson = (await iRes.json()) as { rows?: OrphanageVendorInvoiceRow[]; error?: string };
      if (!vRes.ok || vJson.error) throw new Error(vJson.error ?? 'Failed to load vendors');
      if (!iRes.ok || iJson.error) throw new Error(iJson.error ?? 'Failed to load invoices');
      setVendors(vJson.rows ?? []);
      setInvoices(iJson.rows ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load 3rd party vendors');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Vendor handlers ──────────────────────────────────────────────────────────
  const handleVendorSaved = (row: OrphanageVendorRow) => {
    setVendors((prev) => {
      const exists = prev.some((v) => v.id === row.id);
      const next = exists ? prev.map((v) => (v.id === row.id ? row : v)) : [...prev, row];
      return next.sort((a, b) => a.business_name.localeCompare(b.business_name));
    });
    setVendorDialogOpen(false);
    setEditingVendor(null);
  };

  const handleDeleteVendor = async (v: OrphanageVendorRow) => {
    if (!window.confirm(`Remove "${v.business_name}" from the vendor directory? Existing invoices keep their details.`)) return;
    const prev = vendors;
    setVendors((rows) => rows.filter((r) => r.id !== v.id));
    // The DB FK is ON DELETE SET NULL, so existing invoices keep their snapshot
    // but lose vendor_id. Mirror that locally now — otherwise editing one of
    // those invoices would re-send a dangling vendor_id and fail the FK.
    setInvoices((rows) => rows.map((i) => (i.vendor_id === v.id ? { ...i, vendor_id: null } : i)));
    try {
      const res = await fetch(`/api/orphanage-vendors/${v.id}`, { method: 'DELETE' });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Delete failed');
      toast.success(`Removed ${v.business_name}`);
    } catch (e) {
      setVendors(prev);
      toast.error(e instanceof Error ? e.message : 'Could not remove vendor');
    }
  };

  // ── Invoice handlers ─────────────────────────────────────────────────────────
  const handleInvoiceSaved = (row: OrphanageVendorInvoiceRow) => {
    setInvoices((prev) => {
      const exists = prev.some((i) => i.id === row.id);
      return exists ? prev.map((i) => (i.id === row.id ? row : i)) : [row, ...prev];
    });
    setInvoiceDialogOpen(false);
    setEditingInvoice(null);
  };

  const handleMarkPaid = async (invoice: OrphanageVendorInvoiceRow, payload: VendorInvoicePaidPayload) => {
    const res = await fetch(`/api/orphanage-vendor-invoices/${invoice.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'mark_paid',
        paid_by: viewerEmail,
        paid_transaction_id: payload.paid_transaction_id,
        paid_bank_used: payload.paid_bank_used,
        paid_sent_date: payload.paid_sent_date,
        paid_note: payload.paid_note,
      }),
    });
    const json = (await res.json()) as { row?: OrphanageVendorInvoiceRow; error?: string };
    if (!res.ok || json.error || !json.row) {
      toast.error(json.error ?? 'Could not mark paid');
      return;
    }
    const paid = json.row;
    setInvoices((prev) => prev.map((i) => (i.id === paid.id ? paid : i)));
    setMarkPaidInvoice(null);
    toast.success(`Invoice ${paid.invoice_number} marked paid`, { icon: '✅' });
  };

  const handleDeleteInvoice = async (invoice: OrphanageVendorInvoiceRow) => {
    if (!window.confirm(`Delete invoice ${invoice.invoice_number}? This cannot be undone.`)) return;
    const prev = invoices;
    setInvoices((rows) => rows.filter((r) => r.id !== invoice.id));
    try {
      const res = await fetch(`/api/orphanage-vendor-invoices/${invoice.id}`, { method: 'DELETE' });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Delete failed');
      toast.success('Invoice deleted');
    } catch (e) {
      setInvoices(prev);
      toast.error(e instanceof Error ? e.message : 'Could not delete invoice');
    }
  };

  const pendingInvoices = useMemo(() => invoices.filter((i) => i.status === 'pending'), [invoices]);
  const paidInvoices = useMemo(() => invoices.filter((i) => i.status === 'paid'), [invoices]);
  const pendingTotal = useMemo(
    () => pendingInvoices.reduce((s, i) => s + (i.total_amount || 0), 0),
    [pendingInvoices],
  );

  return (
    <div className="flex flex-col gap-6 px-4 pb-10 pt-6 sm:px-6 lg:gap-8 lg:px-8 lg:pt-8">
      {/* Header */}
      <header className="relative overflow-hidden rounded-2xl border border-pink-100/90 bg-gradient-to-br from-pink-600 via-rose-600 to-zinc-900 px-5 py-7 text-white shadow-lg shadow-pink-600/20 dark:border-pink-900/50 dark:from-pink-700 dark:via-rose-900 dark:to-black sm:px-7">
        <div className="absolute -right-10 -top-10 h-36 w-36 rounded-full bg-white/15 blur-3xl" aria-hidden />
        <div className="absolute -bottom-12 left-8 h-32 w-32 rounded-full bg-rose-300/25 blur-2xl" aria-hidden />
        <div className="relative flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-pink-100/95">
              <Receipt className="h-3 w-3 shrink-0" />
              3rd party vendors
            </div>
            <h1 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
              Vendor invoices &amp; payments
            </h1>
            <p className="max-w-2xl text-sm leading-relaxed text-pink-100/85">
              Save the outside businesses the orphanage buys from, raise a SIMPLE-branded invoice, and
              mark it paid once you&apos;ve sent the money — it stamps a <b>PAID</b> watermark on the invoice.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2" data-readonly-allow>
            <Button
              variant="outline"
              size="sm"
              className="border-white/35 bg-white/10 text-white backdrop-blur-sm hover:bg-white/20 hover:text-white"
              onClick={() => void load()}
              disabled={loading}
            >
              <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </div>
      </header>

      {/* Sub-tab nav */}
      <nav
        role="tablist"
        className="inline-flex w-full flex-wrap items-center gap-1 rounded-lg border border-pink-100/80 bg-white/80 p-1 sm:w-fit dark:border-pink-950/45 dark:bg-zinc-950/60"
        aria-label="3rd party vendor sections"
        data-readonly-allow
      >
        <SubTabButton active={subTab === 'invoices'} onClick={() => setSubTab('invoices')} Icon={FileText} label="Invoices" count={pendingInvoices.length} />
        <SubTabButton active={subTab === 'vendors'} onClick={() => setSubTab('vendors')} Icon={Building2} label="Vendors" count={vendors.length} />
      </nav>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
          {error}{' '}
          <button type="button" onClick={() => void load()} className="font-semibold underline">
            Retry
          </button>
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-sm text-zinc-500">
          <Loader2 className="h-5 w-5 animate-spin text-pink-500" />
          Loading…
        </div>
      ) : (
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={subTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            {subTab === 'invoices' ? (
              <div className="flex flex-col gap-6">
                {/* Summary + create */}
                <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
                  <div className="grid flex-1 gap-3 sm:grid-cols-3">
                    <StatTile label="Pending invoices" value={String(pendingInvoices.length)} icon={Clock} />
                    <StatTile label="Pending total" value={formatVendorPHP(pendingTotal)} icon={Banknote} prominent />
                    <StatTile label="Paid invoices" value={String(paidInvoices.length)} icon={CheckCircle2} />
                  </div>
                  <Button
                    onClick={() => {
                      if (vendors.length === 0) {
                        toast.info('Add a vendor first — or type the vendor name on the invoice.');
                      }
                      setEditingInvoice(null);
                      setInvoiceDialogOpen(true);
                    }}
                    className="shrink-0 gap-2 self-stretch bg-gradient-to-br from-pink-600 to-rose-700 text-white hover:from-pink-600 hover:to-rose-800 sm:self-auto"
                  >
                    <Plus className="h-4 w-4" />
                    New invoice
                  </Button>
                </div>

                {invoices.length === 0 ? (
                  <EmptyState
                    icon={Receipt}
                    title="No invoices yet"
                    body="Create a SIMPLE-branded invoice for a 3rd-party vendor. It stays pending until you mark it paid."
                    cta="New invoice"
                    onCta={() => {
                      setEditingInvoice(null);
                      setInvoiceDialogOpen(true);
                    }}
                  />
                ) : (
                  <>
                    {pendingInvoices.length > 0 && (
                      <Section title="Pending" count={pendingInvoices.length} Icon={Clock} accent="amber">
                        <div className="flex flex-col gap-3">
                          {pendingInvoices.map((inv) => (
                            <InvoiceCard
                              key={inv.id}
                              invoice={inv}
                              onView={() => setPreviewInvoice(inv)}
                              onPrint={() => printInvoice(inv)}
                              onMarkPaid={() => setMarkPaidInvoice(inv)}
                              onEdit={() => {
                                setEditingInvoice(inv);
                                setInvoiceDialogOpen(true);
                              }}
                              onDelete={() => void handleDeleteInvoice(inv)}
                            />
                          ))}
                        </div>
                      </Section>
                    )}
                    {paidInvoices.length > 0 && (
                      <Section title="Paid" count={paidInvoices.length} Icon={CheckCircle2} accent="emerald">
                        <div className="flex flex-col gap-3">
                          {paidInvoices.map((inv) => (
                            <InvoiceCard
                              key={inv.id}
                              invoice={inv}
                              onView={() => setPreviewInvoice(inv)}
                              onPrint={() => printInvoice(inv)}
                              onDelete={() => void handleDeleteInvoice(inv)}
                            />
                          ))}
                        </div>
                      </Section>
                    )}
                  </>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
                  <div className="grid flex-1 gap-3 sm:grid-cols-2">
                    <StatTile label="Vendors saved" value={String(vendors.length)} icon={Building2} />
                    <StatTile label="With banking on file" value={String(vendors.filter(vendorHasBanking).length)} icon={Banknote} />
                  </div>
                  <Button
                    onClick={() => {
                      setEditingVendor(null);
                      setVendorDialogOpen(true);
                    }}
                    className="shrink-0 gap-2 self-stretch bg-gradient-to-br from-pink-600 to-rose-700 text-white hover:from-pink-600 hover:to-rose-800 sm:self-auto"
                  >
                    <Plus className="h-4 w-4" />
                    Add vendor
                  </Button>
                </div>

                {vendors.length === 0 ? (
                  <EmptyState
                    icon={Building2}
                    title="No vendors yet"
                    body="Add the outside businesses the orphanage pays for goods or services. You'll reuse them on invoices."
                    cta="Add vendor"
                    onCta={() => {
                      setEditingVendor(null);
                      setVendorDialogOpen(true);
                    }}
                  />
                ) : (
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {vendors.map((v) => (
                      <VendorCard
                        key={v.id}
                        vendor={v}
                        onEdit={() => {
                          setEditingVendor(v);
                          setVendorDialogOpen(true);
                        }}
                        onDelete={() => void handleDeleteVendor(v)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      )}

      {/* Dialogs */}
      <VendorDialog
        open={vendorDialogOpen}
        onOpenChange={(o) => {
          setVendorDialogOpen(o);
          if (!o) setEditingVendor(null);
        }}
        editing={editingVendor}
        viewerEmail={viewerEmail}
        onSaved={handleVendorSaved}
      />
      <VendorInvoiceBuilderDialog
        open={invoiceDialogOpen}
        onOpenChange={(o) => {
          setInvoiceDialogOpen(o);
          if (!o) setEditingInvoice(null);
        }}
        editing={editingInvoice}
        vendors={vendors}
        viewerEmail={viewerEmail}
        onSaved={handleInvoiceSaved}
      />
      <VendorInvoiceMarkPaidDialog
        invoice={markPaidInvoice}
        onClose={() => setMarkPaidInvoice(null)}
        onConfirm={handleMarkPaid}
      />
      <VendorInvoiceDocument
        invoice={previewInvoice}
        open={!!previewInvoice}
        onClose={() => setPreviewInvoice(null)}
      />
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SubTabButton({
  active,
  onClick,
  Icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  Icon: React.ComponentType<{ className?: string }>;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-2 rounded-md px-3.5 py-1.5 text-[13px] font-medium transition-colors',
        active
          ? 'bg-gradient-to-r from-pink-600 to-rose-700 text-white shadow-sm shadow-pink-600/25'
          : 'text-zinc-600 hover:bg-pink-50 hover:text-pink-900 dark:text-zinc-300 dark:hover:bg-pink-950/30 dark:hover:text-pink-100',
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
      {typeof count === 'number' && count > 0 && (
        <span
          className={cn(
            'rounded-full px-1.5 py-0.5 text-[10px] font-bold',
            active ? 'bg-white/25 text-white' : 'bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300',
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function StatTile({
  label,
  value,
  icon: Icon,
  prominent = false,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  prominent?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl border px-4 py-3',
        prominent
          ? 'border-pink-300/80 bg-gradient-to-br from-pink-50 to-rose-100/60 dark:border-pink-800/50 dark:from-pink-950/40 dark:to-rose-950/30'
          : 'border-pink-100/80 bg-white dark:border-pink-950/45 dark:bg-zinc-950/60',
      )}
    >
      <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', prominent ? 'bg-pink-600 text-white' : 'bg-pink-100 text-pink-600 dark:bg-pink-950/50 dark:text-pink-300')}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-pink-700/80 dark:text-pink-300/80">{label}</p>
        <p className={cn('mt-0.5 font-mono text-lg font-bold tabular-nums tracking-tight', prominent ? 'text-pink-800 dark:text-pink-200' : 'text-zinc-900 dark:text-white')}>
          {value}
        </p>
      </div>
    </div>
  );
}

function Section({
  title,
  count,
  Icon,
  accent,
  children,
}: {
  title: string;
  count: number;
  Icon: React.ComponentType<{ className?: string }>;
  accent: 'amber' | 'emerald';
  children: React.ReactNode;
}) {
  const badge =
    accent === 'amber'
      ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
      : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
  const iconColor = accent === 'amber' ? 'text-amber-500' : 'text-emerald-500';
  return (
    <section>
      <h2 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
        <Icon className={cn('h-3.5 w-3.5', iconColor)} />
        {title}
        <span className={cn('ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold', badge)}>{count}</span>
      </h2>
      {children}
    </section>
  );
}

function InvoiceCard({
  invoice,
  onView,
  onPrint,
  onMarkPaid,
  onEdit,
  onDelete,
}: {
  invoice: OrphanageVendorInvoiceRow;
  onView: () => void;
  onPrint: () => void;
  onMarkPaid?: () => void;
  onEdit?: () => void;
  onDelete: () => void;
}) {
  const isPaid = invoice.status === 'paid';
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      className={cn(
        'flex flex-col gap-3 rounded-2xl border bg-white p-4 shadow-sm dark:bg-zinc-950 sm:flex-row sm:items-start sm:justify-between',
        isPaid ? 'border-emerald-200/70 dark:border-emerald-900/40' : 'border-pink-200/70 dark:border-pink-900/40',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
              isPaid ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
            )}
          >
            {isPaid ? 'Paid' : 'Pending'}
          </span>
          <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">{invoice.invoice_number}</span>
        </div>
        <p className="mt-1.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{invoice.vendor_name}</p>
        <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
          Invoice {formatDate(invoice.invoice_date)}
          {invoice.due_date ? ` · Due ${formatDate(invoice.due_date)}` : ''}
          {isPaid && invoice.paid_at ? ` · Paid ${formatDate(invoice.paid_at)}` : ''}
          {invoice.line_items.length ? ` · ${invoice.line_items.length} line${invoice.line_items.length === 1 ? '' : 's'}` : ''}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-2">
        <span className="text-xl font-bold tabular-nums text-zinc-900 dark:text-zinc-100">
          {formatVendorPHP(invoice.total_amount)}
        </span>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <CardBtn onClick={onView} title="View invoice" readOnlyAllow>
            <Eye className="h-3.5 w-3.5" /> View
          </CardBtn>
          <CardBtn onClick={onPrint} title="Print / Save PDF" readOnlyAllow>
            <Printer className="h-3.5 w-3.5" />
          </CardBtn>
          {onEdit && !isPaid && (
            <CardBtn onClick={onEdit} title="Edit invoice">
              <Pencil className="h-3.5 w-3.5" />
            </CardBtn>
          )}
          <CardBtn onClick={onDelete} title="Delete invoice" danger>
            <Trash2 className="h-3.5 w-3.5" />
          </CardBtn>
          {onMarkPaid && !isPaid && (
            <Button
              size="sm"
              onClick={onMarkPaid}
              className="h-7 gap-1.5 bg-gradient-to-br from-emerald-500 to-teal-600 px-2.5 text-[11px] font-semibold text-white hover:brightness-110"
            >
              <CheckCircle2 className="h-3.5 w-3.5" /> Mark paid
            </Button>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function CardBtn({
  onClick,
  title,
  danger,
  readOnlyAllow,
  children,
}: {
  onClick: () => void;
  title: string;
  danger?: boolean;
  /** Keep this action live for view-only users (read-safe: View / Print). */
  readOnlyAllow?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      {...(readOnlyAllow ? { 'data-readonly-allow': '' } : {})}
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors',
        danger
          ? 'border-rose-200 bg-white text-rose-600 hover:bg-rose-50 dark:border-rose-900/40 dark:bg-zinc-950 dark:text-rose-400 dark:hover:bg-rose-950/30'
          : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900',
      )}
    >
      {children}
    </button>
  );
}

function VendorCard({
  vendor,
  onEdit,
  onDelete,
}: {
  vendor: OrphanageVendorRow;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const bankTag = vendor.swift_code
    ? `SWIFT ${vendor.swift_code}`
    : vendor.routing_number
      ? `Routing ${vendor.routing_number}`
      : null;
  return (
    <article className="flex flex-col overflow-hidden rounded-xl border border-pink-100/80 bg-white shadow-sm transition-shadow hover:shadow-md hover:shadow-pink-500/10 dark:border-pink-950/45 dark:bg-zinc-950/60">
      <div className="flex items-start justify-between gap-2 border-b border-pink-100/70 bg-gradient-to-br from-pink-50/60 to-white px-4 py-3 dark:border-pink-950/40 dark:from-pink-950/20 dark:to-zinc-950">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-pink-600 to-rose-700 text-white shadow-sm shadow-pink-600/25">
            <Building2 className="h-4 w-4" />
          </div>
          <h3 className="min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-white" title={vendor.business_name}>
            {vendor.business_name}
          </h3>
        </div>
        <div className="flex shrink-0 gap-1">
          <IconBtn label="Edit" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </IconBtn>
          <IconBtn label="Remove" danger onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </IconBtn>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-2.5 p-4">
        <dl className="flex flex-col gap-1.5 text-[12px] leading-snug text-zinc-600 dark:text-zinc-400">
          {vendor.contact_name && <DetailRow Icon={Building2} value={vendor.contact_name} />}
          {vendor.contact_phone && <DetailRow Icon={Phone} value={vendor.contact_phone} mono />}
          {vendor.contact_email && <DetailRow Icon={Mail} value={vendor.contact_email} mono />}
          {(vendor.city || vendor.address_line1) && (
            <DetailRow Icon={MapPin} value={[vendor.address_line1, vendor.city, vendor.country].filter(Boolean).join(', ')} />
          )}
        </dl>

        {vendor.products_services && (
          <div className="flex items-start gap-1.5 rounded-lg bg-pink-50/50 px-2.5 py-2 text-[11px] text-zinc-600 dark:bg-pink-950/15 dark:text-zinc-400">
            <Package className="mt-0.5 h-3.5 w-3.5 shrink-0 text-pink-500/70" />
            <span className="line-clamp-2">{vendor.products_services}</span>
          </div>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
          {vendor.bank_name && (
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              {vendor.bank_name}
            </span>
          )}
          {bankTag && (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
              {bankTag}
            </span>
          )}
          {!vendorHasBanking(vendor) && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
              No banking
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

function IconBtn({
  label,
  danger,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-md bg-white/90 text-zinc-700 shadow-sm transition-colors hover:bg-white dark:bg-zinc-900/90 dark:text-zinc-200',
        danger && 'hover:text-rose-600 dark:hover:text-rose-400',
      )}
    >
      {children}
    </button>
  );
}

function DetailRow({
  Icon,
  value,
  mono,
}: {
  Icon: React.ComponentType<{ className?: string }>;
  value: string;
  mono?: boolean;
}) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-1.5">
      <Icon className="h-3.5 w-3.5 shrink-0 text-pink-500/70 dark:text-pink-400/70" />
      <span className={cn('min-w-0 truncate', mono && 'font-mono text-[11.5px]')} title={value}>
        {value}
      </span>
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
  body,
  cta,
  onCta,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
  cta: string;
  onCta: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-pink-200/80 bg-pink-50/30 py-16 text-center dark:border-pink-900/40 dark:bg-pink-950/15">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-pink-600 to-rose-700 text-white shadow-sm shadow-pink-600/25">
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-sm font-semibold text-zinc-900 dark:text-white">{title}</p>
        <p className="mx-auto mt-1 max-w-xs text-xs text-zinc-500">{body}</p>
      </div>
      <Button onClick={onCta} className="gap-2 bg-gradient-to-br from-pink-600 to-rose-700 text-white hover:from-pink-600 hover:to-rose-800">
        <Plus className="h-4 w-4" />
        {cta}
      </Button>
    </div>
  );
}
