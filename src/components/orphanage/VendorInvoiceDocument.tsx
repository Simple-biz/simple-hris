'use client';

import { useMemo } from 'react';
import { Printer, X } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { formatVendorPHP, type OrphanageVendorInvoiceRow } from '@/lib/orphanage/vendor';

/**
 * The SIMPLE-branded invoice document for a 3rd-party vendor payment. One pure
 * `buildInvoiceHtml` builder feeds BOTH the on-screen preview (via
 * dangerouslySetInnerHTML) and the print/PDF window, so what you see is exactly
 * what prints. When the invoice is paid, a diagonal "PAID" watermark stamps the
 * page. The Simple logo (/simple-logo.png) sits in the letterhead.
 *
 * All class names are namespaced `siv-` (Simple InVoice) and the <style> lives
 * inside the fragment so the same string works in the app and in a bare print
 * window with no shared stylesheet.
 */

/** Escape a value for safe interpolation into the invoice HTML string. */
function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Render multi-line text (address / notes) with <br> between lines. */
function multiline(v: string | null | undefined): string {
  const t = (v ?? '').trim();
  if (!t) return '';
  return t.split(/\r?\n/).map(esc).join('<br>');
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return esc(iso);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

const SIV_STYLE = `
<style>
  .siv-doc { position: relative; box-sizing: border-box; width: 100%; max-width: 800px; margin: 0 auto;
    background: #ffffff; color: #18181b; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    padding: 44px 48px 40px; border-radius: 4px; }
  .siv-doc * { box-sizing: border-box; }
  .siv-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; border-bottom: 2px solid #ec4899; padding-bottom: 20px; }
  .siv-brand { display: flex; flex-direction: column; gap: 8px; }
  .siv-logo { height: 40px; width: auto; object-fit: contain; }
  .siv-brand-sub { font-size: 11px; color: #71717a; letter-spacing: 0.02em; }
  .siv-title { text-align: right; }
  .siv-title h1 { margin: 0; font-size: 30px; font-weight: 800; letter-spacing: 0.14em; color: #be185d; }
  .siv-meta { margin-top: 8px; font-size: 12px; color: #3f3f46; line-height: 1.6; }
  .siv-meta b { color: #18181b; }
  .siv-parties { display: flex; justify-content: space-between; gap: 28px; margin-top: 26px; }
  .siv-party { flex: 1; min-width: 0; }
  .siv-party h3 { margin: 0 0 6px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.14em; color: #ec4899; }
  .siv-party .siv-name { font-size: 14px; font-weight: 700; color: #18181b; }
  .siv-party p { margin: 3px 0 0; font-size: 12px; color: #3f3f46; line-height: 1.55; }
  .siv-table { width: 100%; border-collapse: collapse; margin-top: 28px; font-size: 12.5px; }
  .siv-table thead th { text-align: left; background: #fdf2f8; color: #9d174d; font-size: 10.5px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.08em; padding: 10px 12px; border-bottom: 1px solid #fbcfe8; }
  .siv-table thead th.siv-num, .siv-table tbody td.siv-num { text-align: right; white-space: nowrap; }
  .siv-table tbody td { padding: 11px 12px; border-bottom: 1px solid #f4f4f5; vertical-align: top; color: #27272a; }
  .siv-table tbody tr:last-child td { border-bottom: 1px solid #e4e4e7; }
  .siv-desc { font-weight: 500; }
  .siv-totals { display: flex; justify-content: flex-end; margin-top: 18px; }
  .siv-totals-inner { width: 280px; }
  .siv-total-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; color: #3f3f46; }
  .siv-total-grand { margin-top: 6px; padding: 12px 14px; border-radius: 8px; background: linear-gradient(135deg, #ec4899, #be185d);
    color: #ffffff; display: flex; justify-content: space-between; align-items: center; font-weight: 800; font-size: 16px; }
  .siv-grid2 { display: flex; gap: 28px; margin-top: 30px; }
  .siv-block { flex: 1; min-width: 0; border: 1px solid #f4f4f5; border-radius: 10px; padding: 14px 16px; background: #fafafa; }
  .siv-block h3 { margin: 0 0 8px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.14em; color: #71717a; }
  .siv-kv { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; padding: 3px 0; }
  .siv-kv span:first-child { color: #71717a; }
  .siv-kv span:last-child { color: #18181b; font-weight: 600; text-align: right; word-break: break-word; }
  .siv-kv .siv-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .siv-notes { margin-top: 24px; font-size: 12px; color: #52525b; line-height: 1.6; border-top: 1px dashed #e4e4e7; padding-top: 14px; }
  .siv-notes h3 { margin: 0 0 5px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.14em; color: #a1a1aa; }
  .siv-foot { margin-top: 30px; text-align: center; font-size: 10.5px; color: #a1a1aa; letter-spacing: 0.03em; }
  .siv-paid-ref { margin-top: 16px; border: 1px solid #a7f3d0; background: #ecfdf5; border-radius: 10px; padding: 12px 16px; }
  .siv-paid-ref h3 { margin: 0 0 6px; color: #047857; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.14em; }
  .siv-watermark { position: absolute; top: 46%; left: 50%; transform: translate(-50%, -50%) rotate(-24deg);
    font-size: 130px; font-weight: 900; letter-spacing: 16px; color: rgba(5,150,105,0.13);
    border: 10px solid rgba(5,150,105,0.13); border-radius: 22px; padding: 6px 46px 14px; pointer-events: none;
    white-space: nowrap; user-select: none; }
  @media print {
    html, body { margin: 0; padding: 0; background: #ffffff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .siv-doc { max-width: none; box-shadow: none; padding: 24px 28px; }
  }
</style>
`;

/** Pure — builds the full invoice fragment (style + markup) for an invoice. */
export function buildInvoiceHtml(inv: OrphanageVendorInvoiceRow): string {
  const rows = (inv.line_items ?? [])
    .map(
      (li) => `
      <tr>
        <td class="siv-desc">${esc(li.description) || '&nbsp;'}</td>
        <td class="siv-num">${esc(li.quantity)}</td>
        <td class="siv-num">${formatVendorPHP(li.unit_price)}</td>
        <td class="siv-num">${formatVendorPHP(li.amount)}</td>
      </tr>`,
    )
    .join('');

  const bankRows: string[] = [];
  if (inv.bank_name) bankRows.push(kv('Bank', inv.bank_name));
  if (inv.account_holder_name) bankRows.push(kv('Account name', inv.account_holder_name));
  if (inv.account_number) bankRows.push(kv('Account no.', inv.account_number, true));
  if (inv.swift_code) bankRows.push(kv('SWIFT', inv.swift_code, true));
  if (inv.routing_number) bankRows.push(kv('Routing no.', inv.routing_number, true));

  const vendorLines: string[] = [];
  if (inv.vendor_contact_name) vendorLines.push(esc(inv.vendor_contact_name));
  if (inv.vendor_address) vendorLines.push(multiline(inv.vendor_address));
  if (inv.vendor_email) vendorLines.push(esc(inv.vendor_email));
  if (inv.vendor_phone) vendorLines.push(esc(inv.vendor_phone));

  const isPaid = inv.status === 'paid';

  const paidRef = isPaid
    ? `
      <div class="siv-paid-ref">
        <h3>Payment received</h3>
        ${inv.paid_transaction_id ? kv('Reference', inv.paid_transaction_id, true) : ''}
        ${inv.paid_bank_used ? kv('Paid from', inv.paid_bank_used) : ''}
        ${inv.paid_sent_date ? kv('Date sent', fmtDate(inv.paid_sent_date)) : ''}
        ${inv.paid_by ? kv('Marked by', inv.paid_by) : ''}
        ${inv.paid_note ? kv('Note', inv.paid_note) : ''}
      </div>`
    : '';

  return `${SIV_STYLE}
  <div class="siv-doc">
    ${isPaid ? '<div class="siv-watermark">PAID</div>' : ''}
    <div class="siv-head">
      <div class="siv-brand">
        <img class="siv-logo" src="/simple-logo.png" alt="Simple" />
        <div class="siv-brand-sub">Simple · Orphanage Program</div>
      </div>
      <div class="siv-title">
        <h1>INVOICE</h1>
        <div class="siv-meta">
          <div><b>#${esc(inv.invoice_number)}</b></div>
          <div>Date: ${fmtDate(inv.invoice_date)}</div>
          ${inv.due_date ? `<div>Due: ${fmtDate(inv.due_date)}</div>` : ''}
          <div>Status: <b>${isPaid ? 'PAID' : 'Pending'}</b></div>
        </div>
      </div>
    </div>

    <div class="siv-parties">
      <div class="siv-party">
        <h3>Vendor · Payee</h3>
        <div class="siv-name">${esc(inv.vendor_name) || '—'}</div>
        ${vendorLines.length ? `<p>${vendorLines.join('<br>')}</p>` : ''}
      </div>
      <div class="siv-party" style="text-align:right">
        <h3>Bill To</h3>
        <div class="siv-name">Simple</div>
        <p>Orphanage Program</p>
      </div>
    </div>

    <table class="siv-table">
      <thead>
        <tr>
          <th>Description</th>
          <th class="siv-num">Qty</th>
          <th class="siv-num">Unit price</th>
          <th class="siv-num">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${rows || '<tr><td class="siv-desc" colspan="4">No line items</td></tr>'}
      </tbody>
    </table>

    <div class="siv-totals">
      <div class="siv-totals-inner">
        <div class="siv-total-grand"><span>Total</span><span>${formatVendorPHP(inv.total_amount)}</span></div>
      </div>
    </div>

    <div class="siv-grid2">
      <div class="siv-block">
        <h3>Payment details</h3>
        ${bankRows.length ? bankRows.join('') : '<div class="siv-kv"><span>No banking on file</span><span></span></div>'}
      </div>
      <div class="siv-block">
        <h3>Summary</h3>
        ${kv('Invoice', inv.invoice_number, true)}
        ${kv('Amount due', formatVendorPHP(inv.total_amount))}
        ${kv('Status', isPaid ? 'Paid' : 'Pending')}
      </div>
    </div>

    ${inv.notes ? `<div class="siv-notes"><h3>Notes</h3>${multiline(inv.notes)}</div>` : ''}
    ${paidRef}

    <div class="siv-foot">Generated by Simple HRIS · This document was produced from the Simple invoice template.</div>
  </div>`;
}

function kv(label: string, value: string, mono = false): string {
  return `<div class="siv-kv"><span>${esc(label)}</span><span class="${mono ? 'siv-mono' : ''}">${esc(value)}</span></div>`;
}

/** Open a bare print window with the invoice and trigger the print dialog once
 *  the logo has loaded (so it isn't missing from the PDF). */
export function printInvoice(inv: OrphanageVendorInvoiceRow): void {
  const w = window.open('', '_blank', 'width=900,height=1200');
  if (!w) {
    toast.error('Enable pop-ups to print or save this invoice as PDF.');
    return;
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Invoice ${esc(inv.invoice_number)}</title>
    <style>body{margin:0;padding:24px;background:#f4f4f5;}</style>
    </head><body>${buildInvoiceHtml(inv)}</body></html>`;
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();

  // Run-once guard: the load/error listeners AND the safety-net timer are all
  // wired to doPrint, but only the first should actually open the dialog —
  // otherwise a second print/Save-PDF dialog pops after the logo loads.
  let printed = false;
  const doPrint = () => {
    if (printed) return;
    printed = true;
    try {
      w.print();
    } catch {
      /* user closed the window */
    }
  };
  const img = w.document.querySelector('img');
  if (img && !img.complete) {
    img.addEventListener('load', doPrint);
    img.addEventListener('error', doPrint);
    // Safety net in case neither event fires.
    w.setTimeout(doPrint, 1200);
  } else {
    w.setTimeout(doPrint, 250);
  }
}

// ── On-screen preview dialog ──────────────────────────────────────────────────

export default function VendorInvoiceDocument({
  invoice,
  open,
  onClose,
}: {
  invoice: OrphanageVendorInvoiceRow | null;
  open: boolean;
  onClose: () => void;
}) {
  const html = useMemo(() => (invoice ? buildInvoiceHtml(invoice) : ''), [invoice]);

  return (
    <Dialog open={open && !!invoice} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[94vh] gap-0 overflow-hidden border-pink-100/70 bg-zinc-100 p-0 sm:max-w-[880px] dark:border-pink-950/50 dark:bg-zinc-900 [&>button]:hidden">
        <DialogTitle className="sr-only">Invoice {invoice?.invoice_number}</DialogTitle>
        <DialogDescription className="sr-only">
          SIMPLE-branded invoice for {invoice?.vendor_name}
        </DialogDescription>

        {/* Toolbar */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Invoice {invoice?.invoice_number}
            </p>
            <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
              {invoice?.vendor_name} · {formatVendorPHP(invoice?.total_amount ?? null)}
              {invoice?.status === 'paid' ? ' · Paid' : ''}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              onClick={() => invoice && printInvoice(invoice)}
              className="h-8 gap-1.5 bg-gradient-to-br from-pink-600 to-rose-700 px-3 text-xs font-semibold text-white hover:brightness-110"
            >
              <Printer className="h-3.5 w-3.5" />
              Print / Save PDF
            </Button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-500 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-900"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Scrollable preview */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <div
            className="shadow-xl shadow-black/10"
            // eslint-disable-next-line react/no-danger -- fully app-generated + escaped invoice markup
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
