// Client-safe types + pure helpers for the Orphanage "3rd party vendors" tab —
// the vendor directory and the SIMPLE-branded invoices raised against them.
//
// Kept free of any server-only import (no Supabase client) so client components
// can use the formatters / builders without pulling server code into the browser
// bundle. The DB access layer lives in:
//   - src/lib/supabase/orphanage-vendors.ts
//   - src/lib/supabase/orphanage-vendor-invoices.ts
// which re-export these for server callers.
//
// This surface is DELIBERATELY separate from Payment Dispatch / orphanage_
// dispatches — see references/sql/create/create_orphanage_vendors.sql.

export type VendorInvoiceStatus = 'pending' | 'paid';

/** A saved 3rd-party vendor the Orphanage pays for goods/services. */
export interface OrphanageVendorRow {
  id: string;
  business_name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  country: string | null;
  /** What the vendor supplies (a few lines). */
  products_services: string | null;
  /** What Simple specifically needs to pay for. */
  payables: string | null;
  bank_name: string;
  account_holder_name: string;
  account_number: string;
  swift_code: string;
  routing_number: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertOrphanageVendorInput {
  business_name: string;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  country?: string | null;
  products_services?: string | null;
  payables?: string | null;
  bank_name?: string | null;
  account_holder_name?: string | null;
  account_number?: string | null;
  swift_code?: string | null;
  routing_number?: string | null;
  note?: string | null;
  created_by?: string | null;
}

/** One row on an invoice. `amount` is the authoritative per-line value. */
export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
}

/** An invoice raised against a vendor, rendered on the SIMPLE template. */
export interface OrphanageVendorInvoiceRow {
  id: string;
  vendor_id: string | null;
  invoice_number: string;
  invoice_date: string;
  due_date: string | null;
  vendor_name: string;
  vendor_contact_name: string | null;
  vendor_email: string | null;
  vendor_phone: string | null;
  vendor_address: string | null;
  bank_name: string;
  account_holder_name: string;
  account_number: string;
  swift_code: string;
  routing_number: string;
  line_items: InvoiceLineItem[];
  total_amount: number;
  notes: string | null;
  status: VendorInvoiceStatus;
  paid_by: string | null;
  paid_at: string | null;
  paid_transaction_id: string | null;
  paid_bank_used: string | null;
  paid_sent_date: string | null;
  paid_note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateOrphanageVendorInvoiceInput {
  vendor_id?: string | null;
  invoice_number: string;
  invoice_date: string;
  due_date?: string | null;
  vendor_name: string;
  vendor_contact_name?: string | null;
  vendor_email?: string | null;
  vendor_phone?: string | null;
  vendor_address?: string | null;
  bank_name?: string | null;
  account_holder_name?: string | null;
  account_number?: string | null;
  swift_code?: string | null;
  routing_number?: string | null;
  line_items: InvoiceLineItem[];
  notes?: string | null;
  created_by?: string | null;
}

/** Fields captured in the mark-paid dialog. */
export interface MarkVendorInvoicePaidInput {
  paid_by?: string | null;
  paid_transaction_id?: string | null;
  paid_bank_used?: string | null;
  paid_sent_date?: string | null;
  paid_note?: string | null;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** ₱ with grouping + 2 decimals (project convention: never drop cents). */
export function formatVendorPHP(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `₱${v.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Coerce anything to a finite number (blank/garbage -> 0). */
export function toAmount(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

/** Round to 2 decimals without float drift (e.g. 3 * 0.1 -> 0.3). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Recompute a line's `amount` from quantity × unit_price (rounded to cents). */
export function normalizeLineItem(li: Partial<InvoiceLineItem>): InvoiceLineItem {
  const quantity = Number.isFinite(li.quantity as number) ? (li.quantity as number) : 0;
  const unit_price = Number.isFinite(li.unit_price as number) ? (li.unit_price as number) : 0;
  return {
    description: (li.description ?? '').toString(),
    quantity,
    unit_price,
    amount: round2(quantity * unit_price),
  };
}

/** Authoritative invoice total = sum of line amounts (rounded to cents). */
export function invoiceTotal(items: readonly InvoiceLineItem[]): number {
  return round2(items.reduce((sum, li) => sum + (Number.isFinite(li.amount) ? li.amount : 0), 0));
}

/** Suggested invoice number, e.g. "INV-20260709-4821". Client-only (uses Date +
 *  a small random suffix for collision-avoidance); never call during SSR render. */
export function suggestInvoiceNumber(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const suffix = String(Math.floor(1000 + Math.random() * 9000));
  return `INV-${y}${m}${d}-${suffix}`;
}

/** Join a vendor's address parts into a display block (skips blanks). */
export function joinVendorAddress(v: {
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  country?: string | null;
}): string {
  return [v.address_line1, v.address_line2, v.city, v.country]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join('\n');
}

/** True when the vendor has enough banking info to actually be paid. */
export function vendorHasBanking(v: {
  account_number?: string | null;
  swift_code?: string | null;
  routing_number?: string | null;
}): boolean {
  const acct = (v.account_number ?? '').trim();
  const swift = (v.swift_code ?? '').trim();
  const routing = (v.routing_number ?? '').trim();
  return acct.length > 0 && (swift.length > 0 || routing.length > 0);
}
