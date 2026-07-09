'use client';

import { useEffect, useState } from 'react';
import { Building2, Loader2 } from 'lucide-react';
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
import type { OrphanageVendorRow, UpsertOrphanageVendorInput } from '@/lib/orphanage/vendor';

/** Add / edit dialog for a 3rd-party vendor. Pink-themed to match the Orphanage
 *  dashboard. On save it POSTs (create) or PATCHes (edit) and hands the fresh
 *  row back to the parent. */
export default function VendorDialog({
  open,
  onOpenChange,
  editing,
  viewerEmail,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  editing: OrphanageVendorRow | null;
  viewerEmail?: string | null;
  onSaved: (row: OrphanageVendorRow) => void;
}) {
  const [businessName, setBusinessName] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('');
  const [products, setProducts] = useState('');
  const [payables, setPayables] = useState('');
  const [bankName, setBankName] = useState('');
  const [accountHolder, setAccountHolder] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [swiftCode, setSwiftCode] = useState('');
  const [routingNumber, setRoutingNumber] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBusinessName(editing?.business_name ?? '');
    setContactName(editing?.contact_name ?? '');
    setContactEmail(editing?.contact_email ?? '');
    setContactPhone(editing?.contact_phone ?? '');
    setAddressLine1(editing?.address_line1 ?? '');
    setAddressLine2(editing?.address_line2 ?? '');
    setCity(editing?.city ?? '');
    setCountry(editing?.country ?? '');
    setProducts(editing?.products_services ?? '');
    setPayables(editing?.payables ?? '');
    setBankName(editing?.bank_name ?? '');
    setAccountHolder(editing?.account_holder_name ?? '');
    setAccountNumber(editing?.account_number ?? '');
    setSwiftCode(editing?.swift_code ?? '');
    setRoutingNumber(editing?.routing_number ?? '');
    setNote(editing?.note ?? '');
  }, [open, editing]);

  const handleSubmit = async () => {
    if (!businessName.trim()) {
      toast.error('Business name is required');
      return;
    }
    setSaving(true);
    const payload: UpsertOrphanageVendorInput = {
      business_name: businessName.trim(),
      contact_name: contactName.trim() || null,
      contact_email: contactEmail.trim() || null,
      contact_phone: contactPhone.trim() || null,
      address_line1: addressLine1.trim() || null,
      address_line2: addressLine2.trim() || null,
      city: city.trim() || null,
      country: country.trim() || null,
      products_services: products.trim() || null,
      payables: payables.trim() || null,
      bank_name: bankName.trim() || null,
      account_holder_name: accountHolder.trim() || null,
      account_number: accountNumber.trim() || null,
      swift_code: swiftCode.trim() || null,
      routing_number: routingNumber.trim() || null,
      note: note.trim() || null,
      ...(editing ? {} : { created_by: viewerEmail ?? null }),
    };
    try {
      const res = await fetch(
        editing ? `/api/orphanage-vendors/${editing.id}` : '/api/orphanage-vendors',
        {
          method: editing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      const json = (await res.json()) as { row?: OrphanageVendorRow; error?: string };
      if (!res.ok || json.error || !json.row) throw new Error(json.error || 'Save failed');
      onSaved(json.row);
      toast.success(editing ? 'Vendor updated' : 'Vendor added');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-h-[92vh] gap-0 overflow-y-auto border-pink-100/70 bg-white p-0 [scrollbar-width:none] sm:max-w-[52rem] [&::-webkit-scrollbar]:hidden dark:border-pink-950/50 dark:bg-zinc-950">
        <DialogHeader className="border-b border-pink-100/70 px-6 py-5 pr-12 text-left dark:border-pink-950/45">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-pink-600 to-rose-700 text-white shadow-sm shadow-pink-600/25">
              <Building2 className="h-4 w-4" />
            </div>
            <DialogTitle className="text-base font-semibold">
              {editing ? 'Edit vendor' : 'Add 3rd-party vendor'}
            </DialogTitle>
          </div>
          <DialogDescription className="text-xs">
            {editing
              ? 'Update this vendor’s contact, products/services, and banking details.'
              : 'Save a vendor once — reuse it on every invoice you raise for them.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 px-6 py-5">
          {/* Business + contact */}
          <Section title="Business & contact">
            <div className="grid grid-cols-2 gap-x-4 gap-y-3.5">
              <div className="col-span-2">
                <Field id="v-biz" label="Business name" required>
                  <Input id="v-biz" value={businessName} onChange={(e) => setBusinessName(e.target.value)} placeholder="e.g. Cebu Hardware Supply Co." />
                </Field>
              </div>
              <Field id="v-contact" label="Contact name">
                <Input id="v-contact" value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Person to reach" />
              </Field>
              <Field id="v-phone" label="Contact phone">
                <Input id="v-phone" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="+63 ..." className="font-mono" />
              </Field>
              <div className="col-span-2">
                <Field id="v-email" label="Contact email">
                  <Input id="v-email" type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="billing@vendor.com" className="font-mono" />
                </Field>
              </div>
            </div>
          </Section>

          {/* Address */}
          <Section title="Address">
            <div className="grid grid-cols-2 gap-x-4 gap-y-3.5">
              <div className="col-span-2">
                <Field id="v-addr1" label="Address line 1">
                  <Input id="v-addr1" value={addressLine1} onChange={(e) => setAddressLine1(e.target.value)} placeholder="Street / building" />
                </Field>
              </div>
              <div className="col-span-2">
                <Field id="v-addr2" label="Address line 2">
                  <Input id="v-addr2" value={addressLine2} onChange={(e) => setAddressLine2(e.target.value)} placeholder="Unit / district (optional)" />
                </Field>
              </div>
              <Field id="v-city" label="City">
                <Input id="v-city" value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" />
              </Field>
              <Field id="v-country" label="Country">
                <Input id="v-country" value={country} onChange={(e) => setCountry(e.target.value)} placeholder="Country" />
              </Field>
            </div>
          </Section>

          {/* Products / services */}
          <Section title="Products & services">
            <div className="grid gap-3.5">
              <Field id="v-products" label="Products & services offered">
                <Textarea id="v-products" value={products} onChange={(e) => setProducts(e.target.value)} rows={3} placeholder="What this vendor supplies (one per line is fine)." />
              </Field>
              <Field id="v-payables" label="What Simple needs to pay for">
                <Textarea id="v-payables" value={payables} onChange={(e) => setPayables(e.target.value)} rows={2} placeholder="The specific service/goods Simple is paying this vendor for." />
              </Field>
            </div>
          </Section>

          {/* Banking */}
          <Section
            title="Banking"
            hint="Provide SWIFT + account no. (international) or routing + account no. (domestic)."
          >
            <div className="grid grid-cols-2 gap-x-4 gap-y-3.5">
              <Field id="v-bank" label="Bank name">
                <Input id="v-bank" value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="BDO, BPI, Chase..." />
              </Field>
              <Field id="v-holder" label="Account holder">
                <Input id="v-holder" value={accountHolder} onChange={(e) => setAccountHolder(e.target.value)} placeholder="Name on the account" />
              </Field>
              <div className="col-span-2">
                <Field id="v-acct" label="Account number">
                  <Input id="v-acct" value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder="Account number" className="font-mono" />
                </Field>
              </div>
              <Field id="v-swift" label="SWIFT / BIC">
                <Input id="v-swift" value={swiftCode} onChange={(e) => setSwiftCode(e.target.value)} placeholder="e.g. BNORPHMM" className="font-mono uppercase" />
              </Field>
              <Field id="v-routing" label="Routing number">
                <Input id="v-routing" value={routingNumber} onChange={(e) => setRoutingNumber(e.target.value)} placeholder="ABA / routing" className="font-mono" />
              </Field>
            </div>
          </Section>

          <Field id="v-note" label="Internal note (optional)">
            <Textarea id="v-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Anything the team should know about this vendor." />
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
            {editing ? 'Save changes' : 'Add vendor'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-pink-700/80 dark:text-pink-300/80">
          {title}
        </h3>
        {hint && <span className="text-[10.5px] text-zinc-400 dark:text-zinc-500">{hint}</span>}
      </div>
      {children}
    </div>
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
