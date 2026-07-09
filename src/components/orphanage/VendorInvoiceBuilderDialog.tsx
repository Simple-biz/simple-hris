'use client';

import { useEffect, useMemo, useState } from 'react';
import { FileText, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  formatVendorPHP,
  joinVendorAddress,
  round2,
  suggestInvoiceNumber,
  toAmount,
  type CreateOrphanageVendorInvoiceInput,
  type OrphanageVendorInvoiceRow,
  type OrphanageVendorRow,
} from '@/lib/orphanage/vendor';

type LineDraft = { description: string; quantity: string; unit_price: string };

const blankLine = (): LineDraft => ({ description: '', quantity: '1', unit_price: '' });

/** Create / edit an invoice against a saved (or free-typed) vendor. Selecting a
 *  saved vendor snapshots its contact + banking onto the invoice; every field
 *  stays editable so the manager can tweak per-invoice. */
export default function VendorInvoiceBuilderDialog({
  open,
  onOpenChange,
  editing,
  vendors,
  viewerEmail,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  editing: OrphanageVendorInvoiceRow | null;
  vendors: OrphanageVendorRow[];
  viewerEmail?: string | null;
  onSaved: (row: OrphanageVendorInvoiceRow) => void;
}) {
  const [vendorId, setVendorId] = useState<string>('');
  const [vendorName, setVendorName] = useState('');
  const [vendorContact, setVendorContact] = useState('');
  const [vendorEmail, setVendorEmail] = useState('');
  const [vendorPhone, setVendorPhone] = useState('');
  const [vendorAddress, setVendorAddress] = useState('');
  const [bankName, setBankName] = useState('');
  const [accountHolder, setAccountHolder] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [swiftCode, setSwiftCode] = useState('');
  const [routingNumber, setRoutingNumber] = useState('');

  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([blankLine()]);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  // Reset / prefill on open.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      // Only pre-select the dropdown if that vendor still exists — a deleted
      // vendor would leave a dangling id that no <option> matches and that a
      // Save would re-send, failing the FK. The snapshot fields below still
      // carry the vendor's details regardless.
      const vendorStillExists = !!editing.vendor_id && vendors.some((v) => v.id === editing.vendor_id);
      setVendorId(vendorStillExists ? editing.vendor_id! : '');
      setVendorName(editing.vendor_name ?? '');
      setVendorContact(editing.vendor_contact_name ?? '');
      setVendorEmail(editing.vendor_email ?? '');
      setVendorPhone(editing.vendor_phone ?? '');
      setVendorAddress(editing.vendor_address ?? '');
      setBankName(editing.bank_name ?? '');
      setAccountHolder(editing.account_holder_name ?? '');
      setAccountNumber(editing.account_number ?? '');
      setSwiftCode(editing.swift_code ?? '');
      setRoutingNumber(editing.routing_number ?? '');
      setInvoiceNumber(editing.invoice_number ?? '');
      setInvoiceDate(editing.invoice_date ?? new Date().toISOString().slice(0, 10));
      setDueDate(editing.due_date ?? '');
      setLines(
        editing.line_items.length
          ? editing.line_items.map((li) => ({
              description: li.description,
              quantity: String(li.quantity),
              unit_price: String(li.unit_price),
            }))
          : [blankLine()],
      );
      setNotes(editing.notes ?? '');
    } else {
      setVendorId('');
      setVendorName('');
      setVendorContact('');
      setVendorEmail('');
      setVendorPhone('');
      setVendorAddress('');
      setBankName('');
      setAccountHolder('');
      setAccountNumber('');
      setSwiftCode('');
      setRoutingNumber('');
      setInvoiceNumber(suggestInvoiceNumber());
      setInvoiceDate(new Date().toISOString().slice(0, 10));
      setDueDate('');
      setLines([blankLine()]);
      setNotes('');
    }
  }, [open, editing]);

  const applyVendor = (v: OrphanageVendorRow) => {
    setVendorId(v.id);
    setVendorName(v.business_name);
    setVendorContact(v.contact_name ?? '');
    setVendorEmail(v.contact_email ?? '');
    setVendorPhone(v.contact_phone ?? '');
    setVendorAddress(joinVendorAddress(v));
    setBankName(v.bank_name ?? '');
    setAccountHolder(v.account_holder_name ?? '');
    setAccountNumber(v.account_number ?? '');
    setSwiftCode(v.swift_code ?? '');
    setRoutingNumber(v.routing_number ?? '');
  };

  const handlePickVendor = (id: string) => {
    if (!id) {
      setVendorId('');
      return;
    }
    const v = vendors.find((x) => x.id === id);
    if (v) applyVendor(v);
  };

  const total = useMemo(
    () => round2(lines.reduce((sum, l) => sum + round2(toAmount(l.quantity) * toAmount(l.unit_price)), 0)),
    [lines],
  );

  const updateLine = (idx: number, patch: Partial<LineDraft>) => {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  };
  const addLine = () => setLines((prev) => [...prev, blankLine()]);
  const removeLine = (idx: number) =>
    setLines((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));

  const handleSubmit = async () => {
    if (!vendorName.trim()) {
      toast.error('Pick a vendor or type a vendor name.');
      return;
    }
    if (!invoiceNumber.trim()) {
      toast.error('Invoice number is required.');
      return;
    }
    const meaningful = lines
      .map((l) => ({
        description: l.description.trim(),
        quantity: toAmount(l.quantity),
        unit_price: toAmount(l.unit_price),
        amount: round2(toAmount(l.quantity) * toAmount(l.unit_price)),
      }))
      .filter((l) => l.description || l.amount !== 0);
    if (meaningful.length === 0) {
      toast.error('Add at least one line item.');
      return;
    }

    setSaving(true);
    const payload: CreateOrphanageVendorInvoiceInput = {
      vendor_id: vendorId || null,
      invoice_number: invoiceNumber.trim(),
      invoice_date: invoiceDate,
      due_date: dueDate || null,
      vendor_name: vendorName.trim(),
      vendor_contact_name: vendorContact.trim() || null,
      vendor_email: vendorEmail.trim() || null,
      vendor_phone: vendorPhone.trim() || null,
      vendor_address: vendorAddress.trim() || null,
      bank_name: bankName.trim() || null,
      account_holder_name: accountHolder.trim() || null,
      account_number: accountNumber.trim() || null,
      swift_code: swiftCode.trim() || null,
      routing_number: routingNumber.trim() || null,
      line_items: meaningful,
      notes: notes.trim() || null,
      ...(editing ? {} : { created_by: viewerEmail ?? null }),
    };
    try {
      const res = await fetch(
        editing ? `/api/orphanage-vendor-invoices/${editing.id}` : '/api/orphanage-vendor-invoices',
        {
          method: editing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      const json = (await res.json()) as { row?: OrphanageVendorInvoiceRow; error?: string };
      if (!res.ok || json.error || !json.row) throw new Error(json.error || 'Save failed');
      onSaved(json.row);
      toast.success(editing ? 'Invoice updated' : 'Invoice created');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-h-[94vh] gap-0 overflow-y-auto border-pink-100/70 bg-white p-0 [scrollbar-width:none] sm:max-w-[62rem] [&::-webkit-scrollbar]:hidden dark:border-pink-950/50 dark:bg-zinc-950">
        <DialogHeader className="border-b border-pink-100/70 px-6 py-5 pr-12 text-left dark:border-pink-950/45">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-pink-600 to-rose-700 text-white shadow-sm shadow-pink-600/25">
              <FileText className="h-4 w-4" />
            </div>
            <DialogTitle className="text-base font-semibold">
              {editing ? 'Edit invoice' : 'New invoice'}
            </DialogTitle>
          </div>
          <DialogDescription className="text-xs">
            Build a SIMPLE-branded invoice. It stays pending until you mark it paid.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-6 px-6 py-5">
          {/* Vendor + invoice meta */}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-3">
              <Field id="i-vendor" label="Saved vendor">
                <select
                  id="i-vendor"
                  value={vendorId}
                  onChange={(e) => handlePickVendor(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-white px-3 text-sm text-zinc-900 outline-none focus-visible:border-pink-400 focus-visible:ring-2 focus-visible:ring-pink-500/40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
                >
                  <option value="">— Select a saved vendor (optional) —</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.business_name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="i-vname" label="Vendor / payee name" required>
                <Input id="i-vname" value={vendorName} onChange={(e) => setVendorName(e.target.value)} placeholder="Business name" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field id="i-vcontact" label="Contact">
                  <Input id="i-vcontact" value={vendorContact} onChange={(e) => setVendorContact(e.target.value)} placeholder="Contact name" />
                </Field>
                <Field id="i-vphone" label="Phone">
                  <Input id="i-vphone" value={vendorPhone} onChange={(e) => setVendorPhone(e.target.value)} placeholder="+63 ..." className="font-mono" />
                </Field>
              </div>
              <Field id="i-vemail" label="Email">
                <Input id="i-vemail" value={vendorEmail} onChange={(e) => setVendorEmail(e.target.value)} placeholder="billing@vendor.com" className="font-mono" />
              </Field>
              <Field id="i-vaddr" label="Address">
                <Textarea id="i-vaddr" value={vendorAddress} onChange={(e) => setVendorAddress(e.target.value)} rows={2} placeholder="Vendor address" />
              </Field>
            </div>

            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                <Field id="i-num" label="Invoice #" required>
                  <Input id="i-num" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} className="font-mono text-xs" />
                </Field>
                <Field id="i-date" label="Invoice date">
                  <Input id="i-date" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
                </Field>
              </div>
              <Field id="i-due" label="Due date (optional)">
                <Input id="i-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </Field>

              {/* Banking */}
              <div className="rounded-xl border border-pink-100/70 bg-pink-50/40 p-3 dark:border-pink-950/40 dark:bg-pink-950/15">
                <p className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.14em] text-pink-700/80 dark:text-pink-300/80">
                  Payment details (where the money goes)
                </p>
                <div className="grid grid-cols-2 gap-2.5">
                  <Field id="i-bank" label="Bank">
                    <Input id="i-bank" value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="Bank name" />
                  </Field>
                  <Field id="i-holder" label="Account holder">
                    <Input id="i-holder" value={accountHolder} onChange={(e) => setAccountHolder(e.target.value)} placeholder="Name on account" />
                  </Field>
                  <div className="col-span-2">
                    <Field id="i-acct" label="Account number">
                      <Input id="i-acct" value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder="Account number" className="font-mono" />
                    </Field>
                  </div>
                  <Field id="i-swift" label="SWIFT / BIC">
                    <Input id="i-swift" value={swiftCode} onChange={(e) => setSwiftCode(e.target.value)} placeholder="e.g. BNORPHMM" className="font-mono uppercase" />
                  </Field>
                  <Field id="i-routing" label="Routing #">
                    <Input id="i-routing" value={routingNumber} onChange={(e) => setRoutingNumber(e.target.value)} placeholder="ABA / routing" className="font-mono" />
                  </Field>
                </div>
              </div>
            </div>
          </div>

          {/* Line items */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-pink-700/80 dark:text-pink-300/80">
                Line items
              </h3>
              <Button type="button" size="sm" variant="outline" onClick={addLine} className="h-7 gap-1.5 px-2.5 text-[11px]">
                <Plus className="h-3.5 w-3.5" /> Add line
              </Button>
            </div>

            <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="bg-zinc-50 text-[10.5px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                    <th className="px-3 py-2 text-left font-semibold">Description</th>
                    <th className="w-20 px-3 py-2 text-right font-semibold">Qty</th>
                    <th className="w-32 px-3 py-2 text-right font-semibold">Unit price</th>
                    <th className="w-32 px-3 py-2 text-right font-semibold">Amount</th>
                    <th className="w-10 px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, idx) => {
                    const amount = round2(toAmount(l.quantity) * toAmount(l.unit_price));
                    return (
                      <tr key={idx} className="border-t border-zinc-100 dark:border-zinc-800">
                        <td className="px-2 py-1.5">
                          <Input
                            value={l.description}
                            onChange={(e) => updateLine(idx, { description: e.target.value })}
                            placeholder="What was supplied"
                            className="h-8 border-0 shadow-none focus-visible:ring-1 focus-visible:ring-pink-400"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input
                            value={l.quantity}
                            onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                            inputMode="decimal"
                            className="h-8 border-0 text-right font-mono shadow-none focus-visible:ring-1 focus-visible:ring-pink-400"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input
                            value={l.unit_price}
                            onChange={(e) => updateLine(idx, { unit_price: e.target.value })}
                            inputMode="decimal"
                            placeholder="0.00"
                            className="h-8 border-0 text-right font-mono shadow-none focus-visible:ring-1 focus-visible:ring-pink-400"
                          />
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-[13px] tabular-nums text-zinc-800 dark:text-zinc-200">
                          {formatVendorPHP(amount)}
                        </td>
                        <td className="px-1 py-1.5 text-center">
                          <button
                            type="button"
                            onClick={() => removeLine(idx)}
                            disabled={lines.length <= 1}
                            aria-label="Remove line"
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40 dark:hover:bg-rose-950/30"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900">
                    <td colSpan={3} className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                      Total
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-base font-bold tabular-nums text-pink-700 dark:text-pink-300">
                      {formatVendorPHP(total)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <Field id="i-notes" label="Notes (optional)">
            <Textarea id="i-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Terms, PO reference, anything to show on the invoice." />
          </Field>
        </div>

        <DialogFooter className="mt-auto gap-2 border-t border-pink-100/70 px-6 py-4 dark:border-pink-950/45">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={saving}
            className="gap-2 bg-gradient-to-br from-pink-600 to-rose-700 text-white hover:from-pink-600 hover:to-rose-800"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {editing ? 'Save changes' : 'Create invoice'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label,
  required,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">
        {label}
        {required && <span className="ml-0.5 text-rose-500">*</span>}
      </Label>
      {children}
    </div>
  );
}

function Textarea({
  className,
  ...props
}: React.ComponentPropsWithoutRef<'textarea'>) {
  return (
    <textarea
      {...props}
      className={cn(
        'flex w-full resize-none rounded-md border border-input bg-white px-3 py-2 text-sm text-zinc-900 outline-none',
        'placeholder:text-zinc-400 focus-visible:ring-2 focus-visible:ring-pink-500/40 focus-visible:border-pink-400',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:border-zinc-800',
        className,
      )}
    />
  );
}
