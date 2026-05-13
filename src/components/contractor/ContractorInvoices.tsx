'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import {
  Plus,
  Trash2,
  Eye,
  Loader2,
  Upload,
  Globe,
  Phone,
  Mail,
  X,
  FileText,
  RotateCcw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

// ─── Types ────────────────────────────────────────────────────────────────────

interface LineItem {
  id: string;
  description: string;
  notes: string;
  qty: number;
  rate: number;
  taxPct: number;
}

interface InvoiceForm {
  fromEntityName: string;
  fromName: string;
  fromAddress: string;
  fromCityStateZip: string;
  fromCountry: string;
  toCompany: string;
  toAddress: string;
  toCountry: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  lineItems: LineItem[];
  notes: string;
  logoUrl: string | null;
}

interface SavedInvoice {
  id: string;
  contractor_email: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  from_entity_name: string;
  from_name: string;
  from_address: string;
  from_city_state_zip: string;
  from_country: string;
  to_company: string;
  to_address: string;
  to_city_state_zip: string;
  to_country: string;
  line_items: LineItem[];
  notes: string;
  subtotal: number;
  tax_total: number;
  total: number;
  created_at: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function emptyItem(): LineItem {
  return { id: uid(), description: '', notes: '', qty: 1, rate: 0, taxPct: 0 };
}

function defaultForm(): InvoiceForm {
  return {
    fromEntityName: '',
    fromName: '',
    fromAddress: '',
    fromCityStateZip: '',
    fromCountry: 'Philippines',
    toCompany: 'Simple.biz',
    toAddress: 'Remote/USA',
    toCountry: 'USA',
    invoiceNumber: 'INV-1',
    invoiceDate: today(),
    dueDate: '',
    lineItems: [emptyItem()],
    notes: '',

    logoUrl: null,
  };
}

function calcLine(item: LineItem) {
  const amount = item.qty * item.rate;
  const tax = amount * (item.taxPct / 100);
  return { amount, tax };
}

function calcTotals(items: LineItem[]) {
  let subtotal = 0;
  let taxTotal = 0;
  for (const item of items) {
    const { amount, tax } = calcLine(item);
    subtotal += amount;
    taxTotal += tax;
  }
  return { subtotal, taxTotal, total: subtotal + taxTotal };
}

function formatPHP(n: number) {
  return `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function FieldLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <label className={cn('mb-1 block text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400', className)}>
      {children}
    </label>
  );
}

function FormInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  className,
}: {
  value: string | number | null | undefined;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  className?: string;
}) {
  return (
    <Input
      type={type}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={cn(
        'h-8 rounded-md border-zinc-200 bg-zinc-50/50 text-sm text-zinc-900 placeholder:text-zinc-400 focus-visible:border-blue-400 focus-visible:ring-blue-400/30 dark:border-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-100 dark:focus-visible:border-blue-500',
        className,
      )}
    />
  );
}

function FormTextarea({
  value,
  onChange,
  placeholder,
  rows = 3,
  className,
}: {
  value: string | null | undefined;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
}) {
  return (
    <textarea
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className={cn(
        'w-full rounded-md border border-zinc-200 bg-zinc-50/50 px-2.5 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-400/20 dark:border-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-100 dark:focus:border-blue-500',
        className,
      )}
    />
  );
}

// ─── Invoice View Dialog ───────────────────────────────────────────────────────

function InvoiceViewDialog({
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

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl overflow-y-auto" showCloseButton>
        <DialogHeader>
          <DialogTitle>Invoice {invoice.invoice_number}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          {/* From / To */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">From</p>
              <p className="font-medium text-zinc-900 dark:text-white">{invoice.from_entity_name || '—'}</p>
              <p className="text-zinc-600 dark:text-zinc-400">{invoice.from_name}</p>
              <p className="text-zinc-500 dark:text-zinc-500">{invoice.from_address}</p>
              <p className="text-zinc-500 dark:text-zinc-500">{invoice.from_city_state_zip}</p>
              <p className="text-zinc-500 dark:text-zinc-500">{invoice.from_country}</p>
            </div>
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Bill To</p>
              <p className="font-medium text-zinc-900 dark:text-white">{invoice.to_company || 'Simple.biz'}</p>
              <p className="text-zinc-500 dark:text-zinc-500">{invoice.to_address || 'Remote/USA'}</p>
              <p className="text-zinc-500 dark:text-zinc-500">{invoice.to_country || 'USA'}</p>
            </div>
          </div>
          {/* Dates */}
          <div className="grid grid-cols-3 gap-3 rounded-lg border border-zinc-100 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-800/50">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Invoice #</p>
              <p className="font-medium text-zinc-900 dark:text-white">{invoice.invoice_number}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Date</p>
              <p className="font-medium text-zinc-900 dark:text-white">{invoice.invoice_date}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Due</p>
              <p className="font-medium text-zinc-900 dark:text-white">{invoice.due_date || '—'}</p>
            </div>
          </div>
          {/* Line items */}
          <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
            <table className="w-full text-xs">
              <thead className="bg-zinc-900 text-white dark:bg-zinc-800">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Description</th>
                  <th className="px-3 py-2 text-right font-semibold">Qty</th>
                  <th className="px-3 py-2 text-right font-semibold">Rate</th>
                  <th className="px-3 py-2 text-right font-semibold">Tax %</th>
                  <th className="px-3 py-2 text-right font-semibold">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {items.map((item, i) => (
                  <tr key={item.id ?? i} className="bg-white dark:bg-zinc-900">
                    <td className="px-3 py-2">
                      <p className="font-medium text-zinc-900 dark:text-white">{item.description}</p>
                      {item.notes && <p className="text-zinc-500">{item.notes}</p>}
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-700 dark:text-zinc-300">{item.qty}</td>
                    <td className="px-3 py-2 text-right text-zinc-700 dark:text-zinc-300">{formatPHP(item.rate)}</td>
                    <td className="px-3 py-2 text-right text-zinc-700 dark:text-zinc-300">{item.taxPct}%</td>
                    <td className="px-3 py-2 text-right font-medium text-zinc-900 dark:text-white">{formatPHP(item.qty * item.rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Totals */}
          <div className="flex justify-end">
            <div className="w-48 space-y-1 text-sm">
              <div className="flex justify-between text-zinc-600 dark:text-zinc-400">
                <span>Subtotal</span>
                <span>{formatPHP(invoice.subtotal)}</span>
              </div>
              <div className="flex justify-between text-zinc-600 dark:text-zinc-400">
                <span>Tax</span>
                <span>{formatPHP(invoice.tax_total)}</span>
              </div>
              <div className="flex justify-between rounded-md bg-zinc-900 px-2 py-1.5 font-bold text-white dark:bg-blue-600">
                <span>TOTAL</span>
                <span>{formatPHP(invoice.total)}</span>
              </div>
            </div>
          </div>
          {invoice.notes && (
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Notes</p>
              <p className="text-zinc-600 dark:text-zinc-400">{invoice.notes}</p>
            </div>
          )}
        </div>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}

// ─── New Invoice Form ──────────────────────────────────────────────────────────

function NewInvoiceForm({
  contractorEmail,
  onSaved,
}: {
  contractorEmail: string;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<InvoiceForm>(defaultForm);
  const [saving, setSaving] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const set = useCallback(<K extends keyof InvoiceForm>(key: K, value: InvoiceForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const setItem = useCallback((id: string, patch: Partial<LineItem>) => {
    setForm((prev) => ({
      ...prev,
      lineItems: prev.lineItems.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    }));
  }, []);

  const addItem = () => {
    setForm((prev) => ({ ...prev, lineItems: [...prev.lineItems, emptyItem()] }));
  };

  const removeItem = (id: string) => {
    setForm((prev) => ({
      ...prev,
      lineItems: prev.lineItems.filter((item) => item.id !== id),
    }));
  };

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Logo too large — maximum 5 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const result = ev.target?.result;
      if (typeof result === 'string') set('logoUrl', result);
    };
    reader.readAsDataURL(file);
  };

  const { subtotal, taxTotal, total } = calcTotals(form.lineItems);

  const handleSave = async () => {
    if (!form.invoiceNumber.trim()) {
      toast.error('Invoice number is required.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/contractor/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contractorEmail,
          ...form,
          subtotal,
          taxTotal,
          total,
        }),
      });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to save');
      toast.success('Invoice saved!', { description: `Invoice ${form.invoiceNumber} has been created.` });
      setForm(defaultForm());
      onSaved();
    } catch (err) {
      toast.error('Failed to save invoice', { description: String(err) });
    } finally {
      setSaving(false);
    }
  };

  const handleClear = () => {
    setForm(defaultForm());
  };

  return (
    <div className="space-y-6 pb-8">
      {/* Top row: Logo + INVOICE heading */}
      <div className="flex items-start gap-4">
        {/* Logo upload */}
        <div
          className={cn(
            'flex h-28 w-28 shrink-0 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-zinc-200 bg-zinc-50 text-center transition-colors hover:border-blue-300 hover:bg-blue-50/50 dark:border-zinc-700 dark:bg-zinc-800/40 dark:hover:border-blue-700',
            form.logoUrl && 'border-solid border-blue-200 bg-white p-1 dark:border-blue-900/60 dark:bg-zinc-900',
          )}
          onClick={() => logoInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && logoInputRef.current?.click()}
          aria-label="Upload company logo"
        >
          {form.logoUrl ? (
            <img src={form.logoUrl} alt="Company logo" className="h-full w-full rounded-lg object-contain" />
          ) : (
            <>
              <Upload className="h-5 w-5 text-zinc-400" />
              <span className="text-[10px] font-medium leading-tight text-zinc-500">Upload Logo</span>
              <span className="text-[9px] leading-tight text-zinc-400">240×240px · max 5MB</span>
            </>
          )}
          <input
            ref={logoInputRef}
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={handleLogoUpload}
          />
        </div>

        <div className="flex flex-1 items-start justify-end">
          <div className="text-right">
            <h2 className="text-3xl font-black uppercase tracking-[0.15em] text-zinc-900 dark:text-white">INVOICE</h2>
            {form.logoUrl && (
              <button
                type="button"
                onClick={() => set('logoUrl', null)}
                className="mt-1 flex items-center gap-1 text-[10px] text-zinc-400 hover:text-red-500"
              >
                <X className="h-3 w-3" /> Remove logo
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Sender section */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-3">
          <div className="text-xs font-bold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">From</div>
          <div>
            <FieldLabel>Entity Name</FieldLabel>
            <FormInput value={form.fromEntityName} onChange={(v) => set('fromEntityName', v)} placeholder="Your Entity / Company" />
          </div>
          <div>
            <FieldLabel>Your Name</FieldLabel>
            <FormInput value={form.fromName} onChange={(v) => set('fromName', v)} placeholder="Full Name" />
          </div>
          <div>
            <FieldLabel>Address</FieldLabel>
            <FormInput value={form.fromAddress} onChange={(v) => set('fromAddress', v)} placeholder="Street Address" />
          </div>
          <div>
            <FieldLabel>City / State / Zip</FieldLabel>
            <FormInput value={form.fromCityStateZip} onChange={(v) => set('fromCityStateZip', v)} placeholder="City, State, ZIP" />
          </div>
          <div>
            <FieldLabel>Country</FieldLabel>
            <FormInput value={form.fromCountry} onChange={(v) => set('fromCountry', v)} placeholder="Philippines" />
          </div>
        </div>

        {/* Contact icon buttons */}
        <div className="flex flex-col items-end justify-start gap-2 pt-6">
          <div className="flex gap-2">
            {[
              { icon: Globe, label: 'Website' },
              { icon: Phone, label: 'Phone' },
              { icon: Mail, label: 'Email' },
            ].map(({ icon: Icon, label }) => (
              <button
                key={label}
                type="button"
                title={label}
                className="flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-500 transition-colors hover:border-blue-300 hover:bg-blue-50 hover:text-blue-600 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:border-blue-700 dark:hover:text-blue-400"
                aria-label={label}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>
        </div>
      </div>

      <hr className="border-zinc-200 dark:border-zinc-700" />

      {/* Bill To + Invoice Meta */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        {/* Bill To */}
        <div className="space-y-3">
          <div className="text-xs font-bold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">Bill To:</div>
          <div className="space-y-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-3 dark:border-zinc-700 dark:bg-zinc-800/50">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Read-only</p>
            <p className="text-sm font-semibold text-zinc-500 dark:text-zinc-400">Simple.biz</p>
            <p className="text-sm text-zinc-400 dark:text-zinc-500">Remote/USA</p>
            <p className="text-sm text-zinc-400 dark:text-zinc-500">USA</p>
          </div>
        </div>

        {/* Invoice Meta */}
        <div className="space-y-3">
          <div className="text-xs font-bold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">Invoice Details</div>
          <div>
            <FieldLabel>Invoice #</FieldLabel>
            <FormInput value={form.invoiceNumber} onChange={(v) => set('invoiceNumber', v)} placeholder="INV-1" />
          </div>
          <div>
            <FieldLabel>Invoice Date</FieldLabel>
            <FormInput type="date" value={form.invoiceDate} onChange={(v) => set('invoiceDate', v)} />
          </div>
          <div>
            <FieldLabel>Due Date</FieldLabel>
            <FormInput type="date" value={form.dueDate} onChange={(v) => set('dueDate', v)} />
          </div>
        </div>
      </div>

      {/* Line Items */}
      <div>
        <div className="mb-2 text-xs font-bold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">Line Items</div>
        <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-700">
          {/* Header */}
          <div className="grid grid-cols-[1fr_60px_90px_70px_80px_32px] gap-0 bg-zinc-900 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-white dark:bg-zinc-800">
            <div>Item Description</div>
            <div className="text-right">Qty</div>
            <div className="text-right">Rate</div>
            <div className="text-right">Tax %</div>
            <div className="text-right">Amount</div>
            <div />
          </div>

          {/* Rows */}
          <div className="divide-y divide-zinc-100 bg-white dark:divide-zinc-800 dark:bg-zinc-900">
            <AnimatePresence initial={false}>
              {form.lineItems.map((item) => {
                const { amount } = calcLine(item);
                return (
                  <motion.div
                    key={item.id}
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                    className="grid grid-cols-[1fr_60px_90px_70px_80px_32px] items-start gap-0 px-3 py-2"
                  >
                    <div className="pr-2">
                      <input
                        type="text"
                        value={item.description ?? ''}
                        onChange={(e) => setItem(item.id, { description: e.target.value })}
                        placeholder="Item description"
                        className="w-full rounded border-0 bg-transparent text-sm text-zinc-900 placeholder:text-zinc-400 outline-none focus:ring-0 dark:text-zinc-100"
                      />
                      <textarea
                        value={item.notes ?? ''}
                        onChange={(e) => setItem(item.id, { notes: e.target.value })}
                        placeholder="Additional notes (optional)"
                        rows={1}
                        className="mt-0.5 w-full resize-none rounded border-0 bg-transparent text-xs text-zinc-500 placeholder:text-zinc-400 outline-none focus:ring-0"
                      />
                    </div>
                    <div>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={item.qty ?? 0}
                        onChange={(e) => setItem(item.id, { qty: parseFloat(e.target.value) || 0 })}
                        className="w-full rounded border border-transparent bg-transparent text-right text-sm text-zinc-900 outline-none focus:border-blue-300 focus:ring-0 dark:text-zinc-100"
                      />
                    </div>
                    <div>
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        value={item.rate ?? 0}
                        onChange={(e) => setItem(item.id, { rate: parseFloat(e.target.value) || 0 })}
                        className="w-full rounded border border-transparent bg-transparent text-right text-sm text-zinc-900 outline-none focus:border-blue-300 focus:ring-0 dark:text-zinc-100"
                      />
                    </div>
                    <div>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={0.1}
                        value={item.taxPct ?? 0}
                        onChange={(e) => setItem(item.id, { taxPct: parseFloat(e.target.value) || 0 })}
                        className="w-full rounded border border-transparent bg-transparent text-right text-sm text-zinc-900 outline-none focus:border-blue-300 focus:ring-0 dark:text-zinc-100"
                      />
                    </div>
                    <div className="text-right text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      {formatPHP(amount)}
                    </div>
                    <div className="flex justify-end">
                      {form.lineItems.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeItem(item.id)}
                          className="ml-1 flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30"
                          aria-label="Remove line item"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>

          {/* Add line item */}
          <div className="border-t border-zinc-100 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/50">
            <button
              type="button"
              onClick={addItem}
              className="flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Line Item
            </button>
          </div>
        </div>
      </div>

      {/* Totals */}
      <div className="flex justify-end">
        <div className="w-52 space-y-1.5 text-sm">
          <div className="flex items-center justify-between text-zinc-600 dark:text-zinc-400">
            <span>Sub Total</span>
            <span className="font-medium text-zinc-800 dark:text-zinc-200">{formatPHP(subtotal)}</span>
          </div>
          <div className="flex items-center justify-between text-zinc-600 dark:text-zinc-400">
            <span>Tax</span>
            <span className="font-medium text-zinc-800 dark:text-zinc-200">{formatPHP(taxTotal)}</span>
          </div>
          <div className="flex items-center justify-between rounded-lg bg-zinc-900 px-3 py-2 text-white dark:bg-blue-700">
            <span className="font-bold uppercase tracking-wide">TOTAL</span>
            <span className="font-bold">{formatPHP(total)}</span>
          </div>
        </div>
      </div>

      {/* Notes */}
      <div>
        <FieldLabel>Notes</FieldLabel>
        <FormTextarea
          value={form.notes}
          onChange={(v) => set('notes', v)}
          placeholder="Payment instructions, thank-you note, etc."
          rows={3}
        />
      </div>

      {/* Payment Gateway */}
      <div>
        <button
          type="button"
          className="flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Payment Gateway
        </button>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-3 border-t border-zinc-100 pt-4 dark:border-zinc-800">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleClear}
          className="gap-1.5 border-zinc-200 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Clear
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={saving}
          className="gap-1.5 bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-500"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
          {saving ? 'Saving…' : 'Save Invoice'}
        </Button>
      </div>
    </div>
  );
}

// ─── Invoice History ───────────────────────────────────────────────────────────

function InvoiceHistory({ contractorEmail, refreshKey }: { contractorEmail: string; refreshKey: number }) {
  const [invoices, setInvoices] = useState<SavedInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewInvoice, setViewInvoice] = useState<SavedInvoice | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchInvoices = useCallback(() => {
    if (!contractorEmail) return;
    setLoading(true);
    fetch(`/api/contractor/invoices?email=${encodeURIComponent(contractorEmail)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { invoices?: SavedInvoice[] }) => setInvoices(j.invoices ?? []))
      .catch(() => setInvoices([]))
      .finally(() => setLoading(false));
  }, [contractorEmail]);

  useEffect(() => {
    fetchInvoices();
  }, [fetchInvoices, refreshKey]);

  const handleDelete = async (id: string, invoiceNumber: string) => {
    if (!confirm(`Delete invoice ${invoiceNumber}? This cannot be undone.`)) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/contractor/invoices?id=${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to delete');
      toast.success('Invoice deleted.');
      fetchInvoices();
    } catch (err) {
      toast.error('Failed to delete', { description: String(err) });
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 text-sm text-zinc-500 dark:text-zinc-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading invoices…
      </div>
    );
  }

  if (invoices.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
        className="flex flex-col items-center gap-3 py-16 text-center"
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-950/40">
          <FileText className="h-6 w-6 text-blue-500 dark:text-blue-400" />
        </div>
        <div>
          <p className="font-medium text-zinc-900 dark:text-white">No invoices yet</p>
          <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">Create your first invoice using the New Invoice tab.</p>
        </div>
      </motion.div>
    );
  }

  return (
    <>
      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
        <Table>
          <TableHeader>
            <TableRow className="bg-zinc-50 dark:bg-zinc-800/50">
              <TableHead className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">Invoice #</TableHead>
              <TableHead className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">Date</TableHead>
              <TableHead className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">Due Date</TableHead>
              <TableHead className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">Client</TableHead>
              <TableHead className="text-right text-xs font-semibold text-zinc-600 dark:text-zinc-400">Total</TableHead>
              <TableHead className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invoices.map((inv) => (
              <TableRow key={inv.id} className="hover:bg-blue-50/40 dark:hover:bg-blue-950/20">
                <TableCell className="font-medium text-zinc-900 dark:text-white">{inv.invoice_number}</TableCell>
                <TableCell className="text-zinc-600 dark:text-zinc-400">{inv.invoice_date || '—'}</TableCell>
                <TableCell className="text-zinc-600 dark:text-zinc-400">{inv.due_date || '—'}</TableCell>
                <TableCell className="text-zinc-600 dark:text-zinc-400">{inv.to_company || '—'}</TableCell>
                <TableCell className="text-right font-semibold text-blue-600 dark:text-blue-400">
                  {formatPHP(inv.total)}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setViewInvoice(inv)}
                      className="h-7 w-7 text-zinc-500 hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-950/30 dark:hover:text-blue-400"
                      aria-label="View invoice"
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={deletingId === inv.id}
                      onClick={() => handleDelete(inv.id, inv.invoice_number)}
                      className="h-7 w-7 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30 dark:hover:text-red-400"
                      aria-label="Delete invoice"
                    >
                      {deletingId === inv.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <InvoiceViewDialog
        invoice={viewInvoice}
        open={!!viewInvoice}
        onClose={() => setViewInvoice(null)}
      />
    </>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────────

export default function ContractorInvoices({ contractorEmail }: { contractorEmail: string }) {
  const [subTab, setSubTab] = useState<'new' | 'history'>('new');
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);

  const handleSaved = () => {
    setSubTab('history');
    setHistoryRefreshKey((k) => k + 1);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Page header */}
      <div className="shrink-0 border-b border-blue-100 bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-blue-950/60 dark:bg-[#0d1117]">
        <h1 className="text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
          Invoices
        </h1>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
          Create and manage your invoices.
        </p>
      </div>

      {/* Sub-tabs */}
      <div className="shrink-0 border-b border-zinc-100 bg-white px-4 dark:border-zinc-800 dark:bg-[#0d1117]">
        <div className="flex gap-0">
          {(['new', 'history'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => {
                setSubTab(tab);
                if (tab === 'history') setHistoryRefreshKey((k) => k + 1);
              }}
              className={cn(
                'relative border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
                subTab === tab
                  ? 'border-blue-500 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                  : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:text-zinc-500 dark:hover:text-zinc-300',
              )}
            >
              {tab === 'new' ? 'New Invoice' : 'History'}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-[#f8faff] px-4 py-6 sm:px-6 dark:bg-[#0d1117]">
        <div className="mx-auto max-w-3xl">
          <AnimatePresence mode="wait">
            <motion.div
              key={subTab}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            >
              {subTab === 'new' ? (
                <NewInvoiceForm contractorEmail={contractorEmail} onSaved={handleSaved} />
              ) : (
                <InvoiceHistory contractorEmail={contractorEmail} refreshKey={historyRefreshKey} />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
