'use client';

// Shared contractor-invoice receipt view. Rendered both in the contractor's
// own dashboard (Invoices -> History -> View) and in the Payroll Wizard's
// Dispatch -> Preview Emails -> Contractors tab, so accounting sees the exact
// same receipt the contractor sees.
//
// Visual language deliberately mirrors the employee PAY STATEMENT preview
// (PayrollWizard "Preview Emails" -> a recipient): an orange card frame, slate
// section bars, a headline "Total" hero, and the same slim tables. The card is
// scaled down as a whole via CSS `zoom` so it fits a small dialog with no
// scrollbar on a normal viewport -- a true resize, not a per-element squash.
// A few non-ASCII punctuation glyphs (declared below) appear in the invoice.

import { FileText } from 'lucide-react';
import { formatMoney, normalizeCurrency } from '@/lib/contractor-currency';
import {
  invoiceProcessor,
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

// Non-ASCII punctuation used in the rendered invoice, declared once here as
// raw UTF-8 literals (these round-trip cleanly on this box).
const EM_DASH = '—'; // em dash
const TIMES = '×'; // multiplication sign
const MIDDOT = '·'; // middle dot

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
  created_at: string;
}

// Short, crisp closing line shown on every rendered invoice (contractor
// dashboard History view + Payroll Wizard dispatch preview). One source of
// truth so the message stays identical across both surfaces.
export const INVOICE_THANK_YOU = 'Thank you for your work ' + EM_DASH + ' it truly matters.';

// Perforated strip framing the receipt top and bottom. Still used by the New
// Invoice builder form; the read-only receipt below uses the paystub card frame.
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

// One slate section bar, matching the pay-statement section headers.
function SectionBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-[#334155] px-3 py-[5px] text-[11px] font-extrabold uppercase leading-[13px] tracking-[0.12em] text-white">
      {children}
    </div>
  );
}

export function InvoiceViewDialog({
  invoice,
  open,
  onClose,
}: {
  invoice: SavedInvoice | null;
  open: boolean;
  onClose: () => void;
}) {
  if (!invoice) return null;
  const items: LineItem[] = Array.isArray(invoice.line_items) ? invoice.line_items : [];
  const cur = normalizeCurrency(invoice.currency);
  const fromName = invoice.from_entity_name || invoice.from_name || EM_DASH;
  const fromLines = [invoice.from_address, invoice.from_city_state_zip, invoice.from_country].filter(Boolean);
  const toLines = [invoice.to_address, invoice.to_city_state_zip, invoice.to_country].filter(Boolean);
  const payLines = paymentMethodLines(invoice.payment_method);
  const payProc = invoice.payment_method ? invoiceProcessor(invoice.payment_method.processor) : undefined;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[95vw] overflow-hidden rounded-2xl border-zinc-200 bg-white p-0 sm:max-w-[540px] dark:border-zinc-800 dark:bg-zinc-950">
        <DialogHeader className="sr-only">
          <DialogTitle>Invoice {invoice.invoice_number}</DialogTitle>
          <DialogDescription>{fromName}</DialogDescription>
        </DialogHeader>

        <div className="relative flex max-h-[90vh] flex-col overflow-hidden bg-[#f4f7fb] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] animate-in fade-in-0 zoom-in-95">
          <div className="flex min-h-0 flex-1 justify-center overflow-y-auto px-4 py-4">
            {/* Full-size invoice, scaled down as a whole via CSS zoom (true resize,
                not a per-element squash) so it fits the small dialog. Same card
                frame + slate bars + tables as the employee pay statement. */}
            <div
              className="w-[560px] shrink-0 overflow-hidden rounded-[17px] bg-[#f97316] p-[3px]"
              style={{ zoom: 0.84, boxShadow: '0 20px 48px rgba(16,32,52,0.16), 0 2px 6px rgba(16,32,52,0.07)' }}
            >
              <div className="overflow-hidden rounded-[14px] bg-[#fbfcfe]">
                {/* Header */}
                <div className="border-b border-[#eef2f6] bg-white px-8 py-5 text-center">
                  {invoice.logo_data_url ? (
                    <img
                      src={invoice.logo_data_url}
                      alt="Logo"
                      className="mx-auto mb-2 block h-12 w-auto max-w-[180px] object-contain"
                    />
                  ) : (
                    <div className="mx-auto mb-2 flex h-11 w-11 items-center justify-center rounded-xl bg-[#f1f5f9]">
                      <FileText className="h-5 w-5 text-[#94a3b8]" />
                    </div>
                  )}
                  <div className="text-[26px] font-bold leading-8 tracking-[0.06em] text-[#102034]">
                    INVOICE
                  </div>
                  <div className="mt-1 text-[13px] leading-[19px] text-[#556377]">
                    No. <span className="font-bold text-[#334155]">{invoice.invoice_number || EM_DASH}</span>
                  </div>
                  <div className="mt-1.5 text-[11px] leading-4 text-[#556377]">
                    Issued {invoice.invoice_date || EM_DASH}
                  </div>
                </div>

                {/* Total Due hero */}
                <div className="px-8 pb-3 pt-3">
                  <div className="overflow-hidden rounded-[10px] border border-[#e2e8f0] bg-[#f8fafc]">
                    <div className="bg-[#334155] px-5 py-[5px] text-[11px] font-extrabold uppercase leading-[13px] tracking-[0.11em] text-white">
                      Total Due
                    </div>
                    <div className="px-5 pb-2.5 pt-2">
                      <div className="text-[34px] font-extrabold leading-10 tracking-tight text-[#102034] tabular-nums">
                        {formatMoney(invoice.total, cur)}
                      </div>
                      <div className="mt-1.5 flex items-center justify-between border-t border-[#e2e8f0] pt-1.5">
                        <span className="text-[12px] leading-[17px] text-[#556377]">Payable in {cur}</span>
                        <span className="text-[12px] font-bold leading-[17px] text-[#26384d]">Due {invoice.due_date || 'on receipt'}</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Bill From / Bill To */}
                <div className="px-8 pb-2.5">
                  <SectionBar>Bill From {MIDDOT} Bill To</SectionBar>
                  <div className="grid grid-cols-2 gap-4 border-b border-[#e2e8f0] py-2">
                    <div className="min-w-0">
                      <div className="text-[10px] font-bold uppercase leading-[13px] tracking-[0.12em] text-[#556377]">From</div>
                      <div className="mt-0.5 text-[14px] font-bold leading-5 text-[#102034]">{fromName}</div>
                      {invoice.from_entity_name && invoice.from_name && (
                        <div className="text-[12px] leading-[16px] text-[#556377]">{invoice.from_name}</div>
                      )}
                      {fromLines.map((l, i) => (
                        <div key={i} className="text-[11px] leading-[15px] text-[#94a3b8]">{l}</div>
                      ))}
                    </div>
                    <div className="min-w-0">
                      <div className="text-[10px] font-bold uppercase leading-[13px] tracking-[0.12em] text-[#556377]">Bill To</div>
                      <div className="mt-0.5 text-[14px] font-bold leading-5 text-[#102034]">{invoice.to_company || 'Simple.biz'}</div>
                      {(toLines.length ? toLines : ['Remote/USA', 'USA']).map((l, i) => (
                        <div key={i} className="text-[11px] leading-[15px] text-[#94a3b8]">{l}</div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Line Items */}
                <div className="px-8 pb-1">
                  <SectionBar>Line Items</SectionBar>
                  <table className="table-keep w-full border-collapse tabular-nums">
                    <tbody>
                      <tr>
                        <td className="border-b border-[#cbd5e1] bg-[#f1f5f9] py-1 text-[10px] font-bold uppercase leading-3 tracking-[0.06em] text-[#334155]">Description</td>
                        <td className="border-b border-[#cbd5e1] bg-[#f1f5f9] px-2 py-1 text-[10px] font-bold uppercase leading-3 tracking-[0.06em] text-[#334155]">Qty {TIMES} Rate</td>
                        <td className="border-b border-[#cbd5e1] bg-[#f1f5f9] py-1 text-right text-[10px] font-bold uppercase leading-3 tracking-[0.06em] text-[#334155]">Amount</td>
                      </tr>
                      {items.length === 0 ? (
                        <tr>
                          <td className="py-2 text-[12px] italic leading-[15px] text-[#94a3b8]" colSpan={3}>No line items.</td>
                        </tr>
                      ) : (
                        items.map((item, i) => {
                          const last = i === items.length - 1;
                          const border = last ? '' : 'border-b border-[#edf2f7]';
                          const detail =
                            `${item.qty} ${TIMES} ${formatMoney(item.rate, cur)}` +
                            (item.taxPct ? ` ${MIDDOT} ${item.taxPct}% tax` : '');
                          return (
                            <tr key={item.id ?? i}>
                              <td className={cn('py-1.5 align-top text-[13px] leading-[15px] text-[#26384d]', border)}>
                                {item.description || EM_DASH}
                                {item.notes && (
                                  <div className="mt-0.5 text-[11px] leading-[14px] text-[#94a3b8]">{item.notes}</div>
                                )}
                              </td>
                              <td className={cn('whitespace-nowrap px-2 py-1.5 align-top text-[12px] leading-[15px] text-[#556377]', border)}>{detail}</td>
                              <td className={cn('whitespace-nowrap py-1.5 align-top text-right text-[13px] font-bold leading-[15px] text-[#102034]', border)}>
                                {formatMoney(item.qty * item.rate, cur)}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>

                  {/* Subtotal / Tax (Total lives in the hero above) */}
                  <div className="ml-auto mt-2 w-[220px] space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] leading-[16px] text-[#556377]">Subtotal</span>
                      <span className="text-[12px] font-semibold leading-[16px] text-[#26384d] tabular-nums">{formatMoney(invoice.subtotal, cur)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] leading-[16px] text-[#556377]">Tax</span>
                      <span className="text-[12px] font-semibold leading-[16px] text-[#26384d] tabular-nums">{formatMoney(invoice.tax_total, cur)}</span>
                    </div>
                  </div>
                </div>

                {/* Notes — fully-rounded callout box (matches the pay statement's
                    Confidential note treatment; no slate bar). */}
                {invoice.notes && (
                  <div className="px-8 pb-1 pt-2">
                    <div className="rounded-[10px] border border-[#e2e8f0] bg-[#f8fafc] px-3.5 py-2 text-[11px] leading-4 text-[#556377]">
                      <strong className="text-[#334155]">Notes:</strong> {invoice.notes}
                    </div>
                  </div>
                )}

                {/* Payment Details — how to pay this invoice */}
                {payLines.length > 0 && (
                  <div className="px-8 pb-1 pt-1">
                    <SectionBar>Payment Details</SectionBar>
                    <div className="border-b border-[#e2e8f0] py-2">
                      <div className="mb-1.5 flex items-center gap-2">
                        <span className="text-[13px] font-bold leading-[16px] text-[#102034]">
                          {payProc?.label ?? 'Payment'}
                        </span>
                        {invoice.payment_method && (
                          <span className="rounded bg-[#eef2f6] px-1.5 py-[1px] text-[9px] font-bold uppercase leading-4 tracking-[0.08em] text-[#556377]">
                            {regionLabel(invoice.payment_method.region)}
                          </span>
                        )}
                      </div>
                      {payLines.map((l) => (
                        <div key={l.label} className="flex items-baseline justify-between gap-4 py-[1px]">
                          <span className="text-[11px] leading-[15px] text-[#94a3b8]">{l.label}</span>
                          <span className="text-[11px] font-semibold leading-[15px] text-[#26384d] tabular-nums">{l.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Thank-you */}
                <div className="bg-[#fbfcfe] px-8 pb-3 pt-3 text-center">
                  <p className="text-[12px] font-semibold leading-4 text-[#334155]">{INVOICE_THANK_YOU}</p>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between border-t border-[#eef2f6] bg-[#f8fafc] px-8 py-2.5">
                  <span className="text-[11px] leading-4 text-[#556377]">Invoice {invoice.invoice_number || EM_DASH}</span>
                  <span className="whitespace-nowrap text-[11px] font-bold leading-4 text-[#334155]">Simple.biz</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
