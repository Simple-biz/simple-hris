import { createSupabaseServiceRoleClient } from './server';
import {
  invoiceTotal,
  normalizeLineItem,
  type CreateOrphanageVendorInvoiceInput,
  type InvoiceLineItem,
  type MarkVendorInvoicePaidInput,
  type OrphanageVendorInvoiceRow,
  type VendorInvoiceStatus,
} from '../orphanage/vendor';

// DB access for SIMPLE-branded invoices raised against 3rd-party vendors. Types +
// pure helpers live in the client-safe module src/lib/orphanage/vendor.ts
// (re-exported here for server callers). This surface is intentionally isolated
// from Payment Dispatch — no orphanage_dispatches / payment_dispatches row is
// ever written. See references/sql/create/create_orphanage_vendors.sql.
export type {
  CreateOrphanageVendorInvoiceInput,
  InvoiceLineItem,
  MarkVendorInvoicePaidInput,
  OrphanageVendorInvoiceRow,
  VendorInvoiceStatus,
} from '../orphanage/vendor';

const SELECT_COLS =
  'id, vendor_id, invoice_number, invoice_date, due_date, vendor_name, vendor_contact_name, vendor_email, vendor_phone, vendor_address, bank_name, account_holder_name, account_number, swift_code, routing_number, line_items, total_amount, notes, status, paid_by, paid_at, paid_transaction_id, paid_bank_used, paid_sent_date, paid_note, created_by, created_at, updated_at';

/** JSONB `line_items` comes back as `unknown`; coerce + re-normalize defensively. */
function coerceRow(raw: Record<string, unknown>): OrphanageVendorInvoiceRow {
  const rawItems = Array.isArray(raw.line_items) ? (raw.line_items as unknown[]) : [];
  const line_items: InvoiceLineItem[] = rawItems.map((li) =>
    normalizeLineItem((li ?? {}) as Partial<InvoiceLineItem>),
  );
  return {
    ...(raw as unknown as OrphanageVendorInvoiceRow),
    line_items,
    total_amount: Number(raw.total_amount) || 0,
  };
}

/** All invoices, optionally filtered by status, newest first. */
export async function listOrphanageVendorInvoices(opts: {
  status?: VendorInvoiceStatus;
} = {}): Promise<{ rows: OrphanageVendorInvoiceRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  let q = supabase
    .from('orphanage_vendor_invoices')
    .select(SELECT_COLS)
    .order('created_at', { ascending: false });
  if (opts.status) q = q.eq('status', opts.status);
  const { data, error } = await q;
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []).map((r) => coerceRow(r as Record<string, unknown>)), error: null };
}

/** Create a pending invoice. The server owns the authoritative total (never
 *  trusts a client-supplied sum) — it's recomputed from the line items here. */
export async function createOrphanageVendorInvoice(
  input: CreateOrphanageVendorInvoiceInput,
): Promise<{ row: OrphanageVendorInvoiceRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };

  const items = (input.line_items ?? []).map(normalizeLineItem);
  const total = invoiceTotal(items);
  const s = (v: string | null | undefined) => (v == null ? null : v.trim() || null);

  const { data, error } = await supabase
    .from('orphanage_vendor_invoices')
    .insert({
      vendor_id: input.vendor_id ?? null,
      invoice_number: input.invoice_number.trim(),
      invoice_date: input.invoice_date,
      due_date: input.due_date || null,
      vendor_name: input.vendor_name.trim(),
      vendor_contact_name: s(input.vendor_contact_name),
      vendor_email: s(input.vendor_email),
      vendor_phone: s(input.vendor_phone),
      vendor_address: s(input.vendor_address),
      bank_name: input.bank_name?.trim() ?? '',
      account_holder_name: input.account_holder_name?.trim() ?? '',
      account_number: input.account_number?.trim() ?? '',
      swift_code: input.swift_code?.trim() ?? '',
      routing_number: input.routing_number?.trim() ?? '',
      line_items: items,
      total_amount: total,
      notes: s(input.notes),
      status: 'pending' as const,
      created_by: input.created_by ?? null,
    })
    .select(SELECT_COLS)
    .single();
  if (error) return { row: null, error: error.message };
  return { row: coerceRow(data as Record<string, unknown>), error: null };
}

/** Edit a still-pending invoice (paid invoices are immutable snapshots). */
export async function updateOrphanageVendorInvoice(
  id: string,
  input: CreateOrphanageVendorInvoiceInput,
): Promise<{ row: OrphanageVendorInvoiceRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };

  const items = (input.line_items ?? []).map(normalizeLineItem);
  const total = invoiceTotal(items);
  const s = (v: string | null | undefined) => (v == null ? null : v.trim() || null);

  const { data, error } = await supabase
    .from('orphanage_vendor_invoices')
    .update({
      vendor_id: input.vendor_id ?? null,
      invoice_number: input.invoice_number.trim(),
      invoice_date: input.invoice_date,
      due_date: input.due_date || null,
      vendor_name: input.vendor_name.trim(),
      vendor_contact_name: s(input.vendor_contact_name),
      vendor_email: s(input.vendor_email),
      vendor_phone: s(input.vendor_phone),
      vendor_address: s(input.vendor_address),
      bank_name: input.bank_name?.trim() ?? '',
      account_holder_name: input.account_holder_name?.trim() ?? '',
      account_number: input.account_number?.trim() ?? '',
      swift_code: input.swift_code?.trim() ?? '',
      routing_number: input.routing_number?.trim() ?? '',
      line_items: items,
      total_amount: total,
      notes: s(input.notes),
    })
    .eq('id', id)
    .eq('status', 'pending')
    .select(SELECT_COLS)
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  if (!data) return { row: null, error: 'Invoice not found or already paid' };
  return { row: coerceRow(data as Record<string, unknown>), error: null };
}

/** Mark a pending invoice paid — stamps the payment record + PAID watermark.
 *  Guarded on status='pending' so a double-click can't re-stamp/overwrite. */
export async function markOrphanageVendorInvoicePaid(
  id: string,
  input: MarkVendorInvoicePaidInput,
): Promise<{ row: OrphanageVendorInvoiceRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };
  const s = (v: string | null | undefined) => (v == null ? null : v.trim() || null);
  const { data, error } = await supabase
    .from('orphanage_vendor_invoices')
    .update({
      status: 'paid' as const,
      paid_by: input.paid_by ?? null,
      paid_at: new Date().toISOString(),
      paid_transaction_id: s(input.paid_transaction_id),
      paid_bank_used: s(input.paid_bank_used),
      paid_sent_date: input.paid_sent_date || null,
      paid_note: s(input.paid_note),
    })
    .eq('id', id)
    .eq('status', 'pending')
    .select(SELECT_COLS)
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  if (!data) return { row: null, error: 'Invoice not found or already paid' };
  return { row: coerceRow(data as Record<string, unknown>), error: null };
}

/** Remove an invoice (typically a pending one entered by mistake). */
export async function deleteOrphanageVendorInvoice(
  id: string,
): Promise<{ ok: boolean; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { ok: false, error: 'Supabase not configured' };
  const { error } = await supabase.from('orphanage_vendor_invoices').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };
  return { ok: true, error: null };
}
