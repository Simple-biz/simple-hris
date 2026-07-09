import { NextRequest, NextResponse } from 'next/server';
import {
  deleteOrphanageVendorInvoice,
  markOrphanageVendorInvoicePaid,
  updateOrphanageVendorInvoice,
  type CreateOrphanageVendorInvoiceInput,
  type InvoiceLineItem,
} from '@/lib/supabase/orphanage-vendor-invoices';
import { normalizeLineItem } from '@/lib/orphanage/vendor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PATCH /api/orphanage-vendor-invoices/{id}
 *   body.action === 'mark_paid' -> stamp the payment record + PAID watermark.
 *   otherwise                   -> edit a still-pending invoice.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireFeatureEdit('orphanage', 'third_party_vendors');
  if (!authz.ok) return deniedResponse(authz);

  const { id } = await params;
  if (!id) return NextResponse.json({ row: null, error: 'Missing id' }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ row: null, error: 'Invalid JSON body' }, { status: 400 });
  }

  const actor = await getSessionActor();

  // ── Mark paid ──────────────────────────────────────────────────────────────
  if (body.action === 'mark_paid') {
    const { row, error } = await markOrphanageVendorInvoicePaid(id, {
      paid_by: (body.paid_by as string | null) ?? actor.user_name,
      paid_transaction_id: (body.paid_transaction_id as string | null) ?? null,
      paid_bank_used: (body.paid_bank_used as string | null) ?? null,
      paid_sent_date: (body.paid_sent_date as string | null) ?? null,
      paid_note: (body.paid_note as string | null) ?? null,
    });
    if (error || !row) {
      const conflict = error === 'Invoice not found or already paid';
      return NextResponse.json(
        { row: null, error: error ?? 'Could not mark paid' },
        { status: conflict ? 409 : 500 },
      );
    }
    void insertAuditLog({
      user_name: row.paid_by || actor.user_name,
      user_role: actor.user_role,
      action: 'orphanage.vendor_invoice.paid',
      resource: 'orphanage_vendor_invoices',
      resource_id: row.id,
      details: {
        invoice_number: row.invoice_number,
        vendor_name: row.vendor_name,
        total_amount: row.total_amount,
        paid_transaction_id: row.paid_transaction_id,
        paid_bank_used: row.paid_bank_used,
        paid_sent_date: row.paid_sent_date,
      },
    });
    return NextResponse.json({ row, error: null });
  }

  // ── Edit a pending invoice ───────────────────────────────────────────────────
  const invoiceNumber = String(body.invoice_number ?? '').trim();
  const vendorName = String(body.vendor_name ?? '').trim();
  if (!invoiceNumber) {
    return NextResponse.json({ row: null, error: 'invoice_number is required' }, { status: 400 });
  }
  if (!vendorName) {
    return NextResponse.json({ row: null, error: 'vendor_name is required' }, { status: 400 });
  }

  const rawItems = Array.isArray(body.line_items) ? (body.line_items as unknown[]) : [];
  const items: InvoiceLineItem[] = rawItems.map((li) =>
    normalizeLineItem((li ?? {}) as Partial<InvoiceLineItem>),
  );
  const meaningful = items.filter((li) => li.description.trim() || li.amount !== 0);
  if (meaningful.length === 0) {
    return NextResponse.json({ row: null, error: 'Add at least one line item' }, { status: 400 });
  }

  const input: CreateOrphanageVendorInvoiceInput = {
    vendor_id: (body.vendor_id as string | null) ?? null,
    invoice_number: invoiceNumber,
    invoice_date: String(body.invoice_date ?? '').trim() || new Date().toISOString().slice(0, 10),
    due_date: (body.due_date as string | null) || null,
    vendor_name: vendorName,
    vendor_contact_name: (body.vendor_contact_name as string | null) ?? null,
    vendor_email: (body.vendor_email as string | null) ?? null,
    vendor_phone: (body.vendor_phone as string | null) ?? null,
    vendor_address: (body.vendor_address as string | null) ?? null,
    bank_name: (body.bank_name as string | null) ?? null,
    account_holder_name: (body.account_holder_name as string | null) ?? null,
    account_number: (body.account_number as string | null) ?? null,
    swift_code: (body.swift_code as string | null) ?? null,
    routing_number: (body.routing_number as string | null) ?? null,
    line_items: meaningful,
    notes: (body.notes as string | null) ?? null,
  };

  const { row, error } = await updateOrphanageVendorInvoice(id, input);
  if (error || !row) {
    const conflict = error === 'Invoice not found or already paid';
    const dup = error && /duplicate key|unique/i.test(error);
    return NextResponse.json(
      { row: null, error: dup ? 'That invoice number already exists' : (error ?? 'Update failed') },
      { status: dup ? 409 : conflict ? 409 : 500 },
    );
  }

  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'orphanage.vendor_invoice.updated',
    resource: 'orphanage_vendor_invoices',
    resource_id: row.id,
    details: {
      invoice_number: row.invoice_number,
      vendor_name: row.vendor_name,
      total_amount: row.total_amount,
    },
  });

  return NextResponse.json({ row, error: null });
}

/** DELETE /api/orphanage-vendor-invoices/{id} */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireFeatureEdit('orphanage', 'third_party_vendors');
  if (!authz.ok) return deniedResponse(authz);

  const { id } = await params;
  if (!id) return NextResponse.json({ ok: false, error: 'Missing id' }, { status: 400 });

  const { ok, error } = await deleteOrphanageVendorInvoice(id);
  if (!ok) return NextResponse.json({ ok: false, error: error ?? 'Delete failed' }, { status: 500 });

  const actor = await getSessionActor();
  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'orphanage.vendor_invoice.deleted',
    resource: 'orphanage_vendor_invoices',
    resource_id: id,
    details: null,
  });

  return NextResponse.json({ ok: true, error: null });
}
