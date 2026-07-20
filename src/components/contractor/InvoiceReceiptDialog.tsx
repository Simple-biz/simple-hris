'use client';

// Shared contractor-invoice view. Rendered both in the contractor's own
// dashboard (Invoices -> History -> View) and in the Payroll Wizard's
// Contractors step + Dispatch -> Preview Emails -> Contractors tab, so
// Accounting sees the exact same invoice the contractor built and submitted.
//
// The read-only document below is a faithful, non-editable mirror of the
// contractor's New Invoice builder (ContractorInvoices -> NewInvoiceForm): the
// same punched-hole receipt frame, FROM / LOCATION / BILL TO / INVOICE DETAILS
// blocks, dark line-items table, dark TOTAL, and payment-rail cards. Keeping the
// layout identical means "View" shows the ACTUAL invoice as it appears on the
// contractor dashboard, not a re-styled copy.
//
// InvoiceViewDialog wraps that document in a zoomable frame: the whole invoice
// fits by default ("100%"), with +/- controls to zoom in for detail.

import { FileText, Globe, Phone, Mail, Check, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatMoney, normalizeCurrency } from '@/lib/contractor-currency';
import {
  invoiceProcessor,
  invoiceProcessorsForCurrency,
  paymentMethodLines,
  regionLabel,
  type InvoicePaymentMethod,
} from '@/lib/contractor/invoice-payment';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

// Em dash used as the empty-value placeholder throughout the document; middle
// dot (spaced) separates the payment-rail label from its region.
const EM_DASH = '—';
const MIDDOT_SPACED = ' · ';

export interface LineItem {
  id: string;
  description: string;
  notes: string;
  qty: number;
  rate: number;
  taxPct: number;
}

export interface SavedInvoice {
  id: string;
  contractor_email: string;
  invoice_number: string;
  invoice_date: string | null;
  due_date: string | null;
  from_entity_name: string;
  from_name: string;
  from_address: string;
  from_city_state_zip: string;
  from_country: string;
  to_company: string;
  to_address: string;
  to_city_state_zip: string;
  to_country: string;
  logo_data_url: string | null;
  currency: string | null;
  line_items: LineItem[];
  notes: string;
  subtotal: number;
  tax_total: number;
  total: number;
  payment_method?: InvoicePaymentMethod | null;
  // Workflow status set by Accounting: 'pending' | 'approved' | 'rejected'.
  status?: string | null;
  created_at: string;
}

// Perforated strip framing the receipt top and bottom. Used by both the New
// Invoice builder form and the read-only document below.
export function PunchedHoles({ position }: { position: 'top' | 'bottom' }) {
  return (
    <div
      className={cn(
        'flex items-center justify-between border-zinc-200 bg-zinc-100 px-3 py-1.5 dark:border-zinc-700 dark:bg-zinc-800',
        position === 'top'
          ? 'rounded-t-xl border border-b-0'
          : 'rounded-b-xl border border-t-0',
      )}
    >
      <div className="flex gap-1.5">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="h-2 w-2 rounded-full bg-white shadow-inner ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-700" />
        ))}
      </div>
      {position === 'top' && (
        <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-zinc-400 dark:text-zinc-500">
          Invoice
        </span>
      )}
      <div className="flex gap-1.5">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="h-2 w-2 rounded-full bg-white shadow-inner ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-700" />
        ))}
      </div>
    </div>
  );
}

// ─── Read-only field primitives (mirror the builder's FieldLabel + FormInput) ──

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
      {children}
    </span>
  );
}

function ReadValue({
  children,
  mono,
  className,
}: {
  children: React.ReactNode;
  mono?: boolean;
  className?: string;
}) {
  const empty = children === null || children === undefined || children === '';
  return (
    <div
      className={cn(
        'flex min-h-8 items-center rounded-md border border-zinc-200 bg-zinc-50/50 px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800/50',
        mono && 'font-mono',
        empty ? 'text-zinc-400 dark:text-zinc-500' : 'text-zinc-900 dark:text-zinc-100',
        className,
      )}
    >
      {empty ? EM_DASH : children}
    </div>
  );
}

// ─── Read-only invoice document ─────────────────────────────────────────────
// A non-editable twin of NewInvoiceForm. Same sections, same styling, filled
// with the submitted invoice's data.

function InvoiceDocument({ invoice }: { invoice: SavedInvoice }) {
  const items: LineItem[] = Array.isArray(invoice.line_items) ? invoice.line_items : [];
  const cur = normalizeCurrency(invoice.currency);
  const entityName = invoice.from_entity_name || EM_DASH;
  const isUsd = cur === 'USD';
  const pm = invoice.payment_method ?? null;
  const payProc = pm ? invoiceProcessor(pm.processor) : undefined;
  const payLines = paymentMethodLines(pm);
  const railOptions = invoiceProcessorsForCurrency(isUsd);

  return (
    <div className="relative">
      <PunchedHoles position="top" />

      {/* Receipt body */}
      <div className="space-y-6 border-x border-zinc-200 bg-white px-6 py-6 sm:px-8 dark:border-zinc-700 dark:bg-zinc-900">
        {/* Top row: Logo + INVOICE heading */}
        <div className="flex items-start gap-4">
          <div
            className={cn(
              'flex h-28 w-28 shrink-0 flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-zinc-200 bg-zinc-50 text-center dark:border-zinc-700 dark:bg-zinc-800/40',
              invoice.logo_data_url && 'border-solid border-blue-200 bg-white p-1 dark:border-blue-900/60 dark:bg-zinc-900',
            )}
          >
            {invoice.logo_data_url ? (
              <img src={invoice.logo_data_url} alt="Company logo" className="h-full w-full rounded-lg object-contain" />
            ) : (
              <FileText className="h-6 w-6 text-zinc-400" />
            )}
          </div>
          <div className="flex flex-1 items-start justify-end">
            <h2 className="text-3xl font-black uppercase tracking-[0.15em] text-zinc-900 dark:text-white">INVOICE</h2>
          </div>
        </div>

        {/* Sender: FROM + LOCATION */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-3">
            <div className="text-xs font-bold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">From</div>
            <div>
              <FieldLabel>Entity Name</FieldLabel>
              <ReadValue>{entityName}</ReadValue>
            </div>
            <div>
              <FieldLabel>Your Name</FieldLabel>
              <ReadValue>{invoice.from_name}</ReadValue>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">Location</span>
              <div className="flex gap-1.5">
                {[Globe, Phone, Mail].map((Icon, i) => (
                  <span
                    key={i}
                    className="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-400 dark:border-zinc-700 dark:bg-zinc-800"
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                ))}
              </div>
            </div>
            <div>
              <FieldLabel>Address</FieldLabel>
              <ReadValue>{invoice.from_address}</ReadValue>
            </div>
            <div>
              <FieldLabel>Country</FieldLabel>
              <ReadValue>{invoice.from_country}</ReadValue>
            </div>
          </div>
        </div>

        <hr className="border-zinc-200 dark:border-zinc-700" />

        {/* Bill To + Invoice Details */}
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div className="space-y-3">
            <div className="text-xs font-bold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">Bill To:</div>
            <div className="space-y-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-3 dark:border-zinc-700 dark:bg-zinc-800/50">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Read-only</p>
              <p className="text-sm font-semibold text-zinc-500 dark:text-zinc-400">{invoice.to_company || 'Simple.biz'}</p>
              <p className="text-sm text-zinc-400 dark:text-zinc-500">{invoice.to_address || 'Remote/USA'}</p>
              <p className="text-sm text-zinc-400 dark:text-zinc-500">{invoice.to_country || 'USA'}</p>
            </div>
          </div>

          <div className="space-y-3">
            <div className="text-xs font-bold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">Invoice Details</div>
            <div>
              <FieldLabel>Currency</FieldLabel>
              <ReadValue>
                <span className="font-semibold">{cur}</span>
              </ReadValue>
            </div>
            <div>
              <FieldLabel>Invoice #</FieldLabel>
              <ReadValue mono>{invoice.invoice_number}</ReadValue>
            </div>
            <div>
              <FieldLabel>Invoice Date</FieldLabel>
              <ReadValue>{invoice.invoice_date}</ReadValue>
            </div>
            <div>
              <FieldLabel>Due Date</FieldLabel>
              <ReadValue>{invoice.due_date}</ReadValue>
            </div>
          </div>
        </div>

        {/* Line Items */}
        <div>
          <div className="mb-2 text-xs font-bold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">Line Items</div>
          <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-700">
            <div className="grid grid-cols-[1fr_60px_90px_70px_90px] gap-0 bg-zinc-900 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-white dark:bg-zinc-800">
              <div>Item Description</div>
              <div className="text-right">Qty</div>
              <div className="text-right">Rate</div>
              <div className="text-right">Tax %</div>
              <div className="text-right">Amount</div>
            </div>
            <div className="divide-y divide-zinc-100 bg-white dark:divide-zinc-800 dark:bg-zinc-900">
              {items.length === 0 ? (
                <div className="px-3 py-3 text-sm italic text-zinc-400">No line items.</div>
              ) : (
                items.map((item, i) => {
                  const amount = (item.qty ?? 0) * (item.rate ?? 0);
                  return (
                    <div
                      key={item.id ?? i}
                      className="grid grid-cols-[1fr_60px_90px_70px_90px] items-start gap-0 px-3 py-2"
                    >
                      <div className="pr-2">
                        <div className="text-sm text-zinc-900 dark:text-zinc-100">{item.description || EM_DASH}</div>
                        {item.notes && (
                          <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{item.notes}</div>
                        )}
                      </div>
                      <div className="text-right text-sm text-zinc-900 dark:text-zinc-100 tabular-nums">{item.qty ?? 0}</div>
                      <div className="text-right text-sm text-zinc-900 dark:text-zinc-100 tabular-nums">{formatMoney(item.rate ?? 0, cur)}</div>
                      <div className="text-right text-sm text-zinc-900 dark:text-zinc-100 tabular-nums">{item.taxPct ?? 0}</div>
                      <div className="text-right text-sm font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">{formatMoney(amount, cur)}</div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Totals */}
        <div className="flex justify-end">
          <div className="w-52 space-y-1.5 text-sm">
            <div className="flex items-center justify-between text-zinc-600 dark:text-zinc-400">
              <span>Sub Total</span>
              <span className="font-medium text-zinc-800 dark:text-zinc-200 tabular-nums">{formatMoney(invoice.subtotal, cur)}</span>
            </div>
            <div className="flex items-center justify-between text-zinc-600 dark:text-zinc-400">
              <span>Tax</span>
              <span className="font-medium text-zinc-800 dark:text-zinc-200 tabular-nums">{formatMoney(invoice.tax_total, cur)}</span>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-zinc-900 px-3 py-2 text-white dark:bg-blue-700">
              <span className="font-bold uppercase tracking-wide">Total</span>
              <span className="font-bold tabular-nums">{formatMoney(invoice.total, cur)}</span>
            </div>
          </div>
        </div>

        {/* Notes */}
        {invoice.notes && (
          <div>
            <FieldLabel>Notes</FieldLabel>
            <div className="whitespace-pre-wrap rounded-md border border-zinc-200 bg-zinc-50/50 px-2.5 py-2 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-300">
              {invoice.notes}
            </div>
          </div>
        )}

        {/* Payment Details */}
        <div>
          <div className="mb-1 text-xs font-bold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">
            Payment Details
          </div>
          <p className="mb-3 text-[11px] text-zinc-400 dark:text-zinc-500">
            {pm
              ? <>How the contractor wants to be paid {MIDDOT_SPACED}<span className="font-semibold text-zinc-500 dark:text-zinc-400">{regionLabel(pm.region)}</span></>
              : 'No payment rail specified on this invoice.'}
          </p>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {railOptions.map((opt) => {
              const active = pm?.processor === opt.id;
              return (
                <div
                  key={opt.id}
                  className={cn(
                    'flex items-center gap-2.5 rounded-xl border px-3.5 py-3 text-left text-xs font-medium',
                    active
                      ? 'border-blue-500/60 bg-blue-50 text-blue-800 shadow-sm dark:border-blue-500/40 dark:bg-blue-950/40 dark:text-blue-200'
                      : 'border-zinc-200 bg-zinc-50 text-zinc-500 opacity-60 dark:border-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-400',
                  )}
                >
                  {opt.logoSrc ? (
                    <img src={opt.logoSrc} alt={opt.label} className="h-4 w-4 rounded object-contain" />
                  ) : (
                    <opt.Icon className="h-4 w-4 shrink-0 opacity-70" />
                  )}
                  <span className="min-w-0 truncate">{opt.label}</span>
                  {active && <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-blue-500" />}
                </div>
              );
            })}
          </div>

          {payLines.length > 0 && (
            <div className="mt-3 grid grid-cols-1 gap-3 rounded-xl border border-zinc-200 bg-zinc-50/60 p-4 sm:grid-cols-2 dark:border-zinc-700 dark:bg-zinc-800/40">
              {payProc && (
                <div className="sm:col-span-2 -mb-1 text-[13px] font-bold text-zinc-800 dark:text-zinc-200">
                  {payProc.label}
                </div>
              )}
              {payLines.map((l) => (
                <div key={l.label} className="min-w-0">
                  <FieldLabel>{l.label}</FieldLabel>
                  <ReadValue>{l.value}</ReadValue>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <PunchedHoles position="bottom" />
    </div>
  );
}

// ─── Zoomable dialog wrapper ─────────────────────────────────────────────────

export function InvoiceViewDialog({
  invoice,
  open,
  onClose,
}: {
  invoice: SavedInvoice | null;
  open: boolean;
  onClose: () => void;
}) {
  // Zoom / fit-to-view state. The document has a fixed natural width (CARD_W) and
  // a content-driven height. We measure both plus the available viewport and pick
  // the scale that makes the WHOLE invoice fit — that fit is "100%". The +/-
  // controls multiply that fit scale, so zooming in reveals detail while the
  // default always shows the entire invoice, never a cropped/pre-zoomed slice.
  const CARD_W = 720;
  const scrollRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const [zoom, setZoom] = useState(1);

  const MIN_ZOOM = 0.4;
  const MAX_ZOOM = 3;
  const VIEWPORT_PAD = 32; // matches the p-4 breathing room around the card

  // Every fresh invoice reopens at fit.
  useEffect(() => {
    if (open) setZoom(1);
  }, [open, invoice?.id]);

  // Measure natural card size + viewport, then recompute the fit scale. A CSS
  // transform: scale() leaves offset* layout dimensions untouched, so these reads
  // report the true unscaled size and the observer never feeds back on itself.
  // scrollbar-gutter: stable keeps clientWidth constant so a toggling scrollbar
  // can't oscillate the fit.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const scroller = scrollRef.current;
      const card = cardRef.current;
      if (!scroller || !card) return;
      const nw = card.offsetWidth;
      const nh = card.offsetHeight;
      if (!nw || !nh) return;
      setNat({ w: nw, h: nh });
      const availW = scroller.clientWidth - VIEWPORT_PAD;
      const availH = scroller.clientHeight - VIEWPORT_PAD;
      const s = Math.min(availW / nw, availH / nh);
      setFitScale(s > 0 && Number.isFinite(s) ? s : 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (scrollRef.current) ro.observe(scrollRef.current);
    if (cardRef.current) ro.observe(cardRef.current);
    return () => ro.disconnect();
  }, [open, invoice?.id]);

  if (!invoice) return null;

  const fromName = invoice.from_entity_name || invoice.from_name || EM_DASH;
  const scale = fitScale * zoom;
  const spacerW = nat ? nat.w * scale : undefined;
  const spacerH = nat ? nat.h * scale : undefined;
  const zoomPct = Math.round(zoom * 100);
  const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));
  const ctrlBtn =
    'flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white';

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[92vh] w-[95vw] flex-col overflow-hidden rounded-2xl border-zinc-200 bg-[#eef2f7] p-0 sm:max-w-[900px] dark:border-zinc-800 dark:bg-zinc-950">
        <DialogHeader className="sr-only">
          <DialogTitle>Invoice {invoice.invoice_number}</DialogTitle>
          <DialogDescription>{fromName}</DialogDescription>
        </DialogHeader>

        {/* Toolbar — invoice identity + zoom controls */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-200/80 bg-white/85 px-4 py-2.5 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/70">
          <div className="min-w-0 pr-8">
            <div className="truncate text-sm font-semibold text-zinc-900 dark:text-white">
              Invoice {invoice.invoice_number || EM_DASH}
            </div>
            <div className="truncate text-[11px] leading-tight text-zinc-500 dark:text-zinc-400">{fromName}</div>
          </div>
          <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-zinc-200 bg-white p-0.5 shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
            <button
              type="button"
              className={ctrlBtn}
              onClick={() => setZoom((z) => clampZoom(z - 0.2))}
              disabled={zoom <= MIN_ZOOM}
              aria-label="Zoom out"
            >
              <ZoomOut className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="min-w-[54px] rounded-md px-1 py-1 text-center text-xs font-semibold tabular-nums text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
              onClick={() => setZoom(1)}
              title="Reset to fit"
            >
              {zoomPct}%
            </button>
            <button
              type="button"
              className={ctrlBtn}
              onClick={() => setZoom((z) => clampZoom(z + 0.2))}
              disabled={zoom >= MAX_ZOOM}
              aria-label="Zoom in"
            >
              <ZoomIn className="h-4 w-4" />
            </button>
            <div className="mx-0.5 h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
            <button type="button" className={ctrlBtn} onClick={() => setZoom(1)} aria-label="Fit to view" title="Fit to view">
              <Maximize2 className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Scroll viewport — the whole invoice fits by default; zoom in to scroll. */}
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-auto p-4"
          style={{ scrollbarGutter: 'stable' }}
        >
          <div style={{ width: spacerW, height: spacerH }} className="relative mx-auto">
            <div
              ref={cardRef}
              className="absolute left-0 top-0 origin-top-left rounded-xl transition-transform duration-150 ease-out"
              style={{
                width: CARD_W,
                transform: `scale(${scale})`,
                boxShadow: '0 20px 48px rgba(16,32,52,0.16), 0 2px 6px rgba(16,32,52,0.07)',
              }}
            >
              <InvoiceDocument invoice={invoice} />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
