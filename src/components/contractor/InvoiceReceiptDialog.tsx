'use client';

// Shared contractor-invoice receipt view. Rendered both in the contractor's
// own dashboard (Invoices -> History -> View) and in the Payroll Wizard's
// Dispatch -> Preview Emails -> Contractors tab, so accounting sees the exact
// same receipt the contractor sees. Kept ASCII-only on purpose.

import { motion, type Variants } from 'motion/react';
import { X, FileText } from 'lucide-react';
import { formatMoney, normalizeCurrency } from '@/lib/contractor-currency';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// Em dash used as a placeholder when a field is empty. Defined as an escape so
// this source file stays ASCII (Write/Edit mangle raw UTF-8 on this box).
const EM_DASH = '—';

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
  created_at: string;
}

const INV_ACCENT = '#B85450';
const INV_ACCENT_DARK = '#D4705A';

const fadeUp = {
  hidden: { opacity: 0, y: 14 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: {
      delay: i * 0.055,
      duration: 0.38,
      ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
    },
  }),
} satisfies Variants;

// Perforated strip framing the receipt top and bottom.
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

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="w-[95vw] !max-w-[850px] gap-0 overflow-visible border-0 bg-transparent p-0 shadow-none"
        showCloseButton={false}
      >
        {/* Font import */}
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap');
          .inv-mono { font-family: 'JetBrains Mono', 'Fira Mono', monospace; }
        `}</style>

        <DialogHeader className="sr-only">
          <DialogTitle>Invoice {invoice.invoice_number}</DialogTitle>
        </DialogHeader>

        {/* Close - floats outside top-right corner */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute -right-4 -top-4 z-20 flex h-8 w-8 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-500 shadow-lg transition-all hover:scale-110 hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>

        {/* Receipt wrapper */}
        <div className="overflow-hidden rounded-2xl shadow-[0_32px_80px_-12px_rgba(0,0,0,0.35)]">
          <PunchedHoles position="top" />

          {/* Body */}
          <div className="relative max-h-[92vh] overflow-y-auto border-x border-zinc-200 bg-[#FAFAF5] dark:border-zinc-700/80 dark:bg-[#0E0E12]">
            {/* Left accent rule */}
            <div
              className="pointer-events-none absolute bottom-0 left-0 top-0 w-[3px]"
              style={{ background: `linear-gradient(to bottom, ${INV_ACCENT}, ${INV_ACCENT}88)` }}
            />

            <div className="inv-mono px-6 py-8 sm:px-10 sm:py-10">

              {/* HEADER */}
              <motion.div
                custom={0} variants={fadeUp} initial="hidden" animate="show"
                className="flex flex-wrap items-start justify-between gap-6"
              >
                {/* Sender block */}
                <div className="flex min-w-0 items-start gap-5">
                  {invoice.logo_data_url ? (
                    <img
                      src={invoice.logo_data_url}
                      alt="Logo"
                      className="h-[72px] w-[72px] shrink-0 rounded-xl object-contain"
                    />
                  ) : (
                    <div className="flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800">
                      <FileText className="h-6 w-6 text-zinc-400 dark:text-zinc-600" />
                    </div>
                  )}
                  <div className="min-w-0 pt-1">
                    <p className="inv-mono text-xl font-bold leading-tight text-zinc-900 dark:text-zinc-50">
                      {invoice.from_entity_name || invoice.from_name || EM_DASH}
                    </p>
                    {invoice.from_entity_name && invoice.from_name && (
                      <p className="mt-0.5 text-[15px] text-zinc-500 dark:text-zinc-400">{invoice.from_name}</p>
                    )}
                    {[invoice.from_address, invoice.from_city_state_zip, invoice.from_country]
                      .filter(Boolean)
                      .map((line, i) => (
                        <p key={i} className="text-[13px] leading-snug text-zinc-400 dark:text-zinc-500">{line}</p>
                      ))}
                  </div>
                </div>

                {/* Invoice title */}
                <div className="shrink-0 text-right">
                  <h2 className="inv-mono text-[36px] font-bold leading-none tracking-tight text-zinc-900 sm:text-[52px] dark:text-zinc-50">
                    INVOICE
                  </h2>
                  <p
                    className="inv-mono mt-2 text-xl font-bold tracking-wider"
                    style={{ color: INV_ACCENT }}
                  >
                    {invoice.invoice_number}
                  </p>
                </div>
              </motion.div>

              {/* RULE */}
              <motion.div custom={1} variants={fadeUp} initial="hidden" animate="show" className="my-8 flex items-center gap-3">
                <div className="h-px flex-1 bg-zinc-900/10 dark:bg-zinc-100/10" />
                <div className="h-1.5 w-1.5 rotate-45 rounded-[1px]" style={{ background: INV_ACCENT }} />
                <div className="h-px flex-1 bg-zinc-900/10 dark:bg-zinc-100/10" />
              </motion.div>

              {/* FROM / BILL TO / DATES */}
              <motion.div
                custom={2} variants={fadeUp} initial="hidden" animate="show"
                className="grid grid-cols-2 gap-6 sm:grid-cols-3"
              >
                {/* From */}
                <div>
                  <p className="inv-mono mb-2 text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-400 dark:text-zinc-500">From</p>
                  <p className="inv-mono text-base font-bold text-zinc-800 dark:text-zinc-100">
                    {invoice.from_entity_name || invoice.from_name || EM_DASH}
                  </p>
                  {invoice.from_entity_name && invoice.from_name && (
                    <p className="text-[13px] text-zinc-500 dark:text-zinc-400">{invoice.from_name}</p>
                  )}
                  {[invoice.from_address, invoice.from_city_state_zip, invoice.from_country]
                    .filter(Boolean)
                    .map((l, i) => (
                      <p key={i} className="text-[12px] text-zinc-400 dark:text-zinc-500">{l}</p>
                    ))}
                </div>

                {/* Bill To */}
                <div>
                  <p className="inv-mono mb-2 text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-400 dark:text-zinc-500">Bill To</p>
                  <p className="inv-mono text-base font-bold text-zinc-800 dark:text-zinc-100">{invoice.to_company || 'Simple.biz'}</p>
                  <p className="text-[13px] text-zinc-500 dark:text-zinc-400">{invoice.to_address || 'Remote/USA'}</p>
                  <p className="text-[12px] text-zinc-400 dark:text-zinc-500">{invoice.to_country || 'USA'}</p>
                </div>

                {/* Dates */}
                <div className="space-y-3">
                  <div>
                    <p className="inv-mono mb-1 text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-400 dark:text-zinc-500">Invoice Date</p>
                    <p className="inv-mono whitespace-nowrap text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                      {invoice.invoice_date || EM_DASH}
                    </p>
                  </div>
                  <div>
                    <p className="inv-mono mb-1 text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-400 dark:text-zinc-500">Due Date</p>
                    <p className="inv-mono whitespace-nowrap text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                      {invoice.due_date || EM_DASH}
                    </p>
                  </div>
                </div>
              </motion.div>

              {/* LINE ITEMS */}
              <motion.div custom={3} variants={fadeUp} initial="hidden" animate="show" className="mt-10 overflow-x-auto">
                <table className="w-full min-w-[480px] table-fixed border-collapse text-[14px]">
                  <colgroup>
                    <col className="w-[40%]" />
                    <col className="w-[10%]" />
                    <col className="w-[18%]" />
                    <col className="w-[10%]" />
                    <col className="w-[22%]" />
                  </colgroup>
                  <thead>
                    <tr style={{ background: '#1C1C24' }}>
                      <th className="inv-mono px-5 py-3.5 text-left text-[9px] font-bold uppercase tracking-[0.18em] text-zinc-400">
                        Description
                      </th>
                      <th className="inv-mono px-4 py-3.5 text-right text-[9px] font-bold uppercase tracking-[0.18em] text-zinc-400">Qty</th>
                      <th className="inv-mono px-4 py-3.5 text-right text-[9px] font-bold uppercase tracking-[0.18em] text-zinc-400">Rate</th>
                      <th className="inv-mono px-4 py-3.5 text-right text-[9px] font-bold uppercase tracking-[0.18em] text-zinc-400">Tax</th>
                      <th className="inv-mono px-5 py-3.5 text-right text-[9px] font-bold uppercase tracking-[0.18em] text-zinc-400">
                        Amount
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, i) => (
                      <tr
                        key={item.id ?? i}
                        className="border-b border-zinc-200/60 last:border-0 dark:border-zinc-700/40"
                        style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(0,0,0,0.018)' }}
                      >
                        <td className="px-5 py-4">
                          <p className="font-medium text-zinc-900 dark:text-zinc-50">{item.description || EM_DASH}</p>
                          {item.notes && (
                            <p className="mt-0.5 text-[12px] text-zinc-400 dark:text-zinc-500">{item.notes}</p>
                          )}
                        </td>
                        <td className="inv-mono px-4 py-4 text-right tabular-nums text-zinc-600 dark:text-zinc-400">{item.qty}</td>
                        <td className="inv-mono px-4 py-4 text-right tabular-nums text-zinc-600 dark:text-zinc-400">{formatMoney(item.rate, cur)}</td>
                        <td className="inv-mono px-4 py-4 text-right tabular-nums text-zinc-500 dark:text-zinc-500">{item.taxPct}%</td>
                        <td className="inv-mono px-5 py-4 text-right tabular-nums font-bold text-zinc-900 dark:text-zinc-50">
                          {formatMoney(item.qty * item.rate, cur)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </motion.div>

              {/* TOTALS */}
              <motion.div custom={4} variants={fadeUp} initial="hidden" animate="show" className="mt-8 flex justify-end">
                <div className="w-64 space-y-2.5 sm:w-72">
                  <div className="flex items-center justify-between text-[14px] text-zinc-500 dark:text-zinc-400">
                    <span>Subtotal</span>
                    <span className="inv-mono tabular-nums font-medium text-zinc-700 dark:text-zinc-300">
                      {formatMoney(invoice.subtotal, cur)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[14px] text-zinc-500 dark:text-zinc-400">
                    <span>Tax</span>
                    <span className="inv-mono tabular-nums font-medium text-zinc-700 dark:text-zinc-300">
                      {formatMoney(invoice.tax_total, cur)}
                    </span>
                  </div>
                  <div
                    className="mt-1 flex items-center justify-between rounded-xl px-5 py-3.5 text-white"
                    style={{ background: '#1C1C24' }}
                  >
                    <span className="inv-mono text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-400">Total Due</span>
                    <span className="inv-mono tabular-nums text-lg font-bold" style={{ color: INV_ACCENT_DARK }}>
                      {formatMoney(invoice.total, cur)}
                    </span>
                  </div>
                </div>
              </motion.div>

              {/* NOTES */}
              {invoice.notes && (
                <motion.div custom={5} variants={fadeUp} initial="hidden" animate="show"
                  className="mt-8 rounded-xl border border-zinc-200/60 bg-zinc-100/60 px-5 py-4 dark:border-zinc-700/40 dark:bg-zinc-800/30"
                >
                  <p className="inv-mono mb-1.5 text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-400 dark:text-zinc-500">Notes</p>
                  <p className="text-[14px] leading-relaxed text-zinc-600 dark:text-zinc-400">{invoice.notes}</p>
                </motion.div>
              )}

              {/* FOOTER */}
              <motion.div custom={6} variants={fadeUp} initial="hidden" animate="show"
                className="mt-10 flex items-center gap-4"
              >
                <div className="h-px flex-1" style={{ background: `linear-gradient(to right, ${INV_ACCENT}44, transparent)` }} />
                <p className="inv-mono text-sm italic text-zinc-400 dark:text-zinc-500">Thank you for your work.</p>
                <div className="h-px flex-1" style={{ background: `linear-gradient(to left, ${INV_ACCENT}44, transparent)` }} />
              </motion.div>

            </div>
          </div>

          <PunchedHoles position="bottom" />
        </div>
      </DialogContent>
    </Dialog>
  );
}
