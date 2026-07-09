import { NextRequest, NextResponse } from 'next/server';
import {
  createOrphanageVendorInvoice,
  listOrphanageVendorInvoices,
  type CreateOrphanageVendorInvoiceInput,
  type InvoiceLineItem,
  type VendorInvoiceStatus,
} from '@/lib/supabase/orphanage-vendor-invoices';
import { normalizeLineItem } from '@/lib/orphanage/vendor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import { requireFeatureAccess, requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/orphanage-vendor-invoices?status=pending|paid -> { rows, error }.
 *  View-gated: rows carry vendor banking details. */
export async function GET(req: NextRequest) {
  const authz = await requireFeatureAccess('orphanage', 'third_party_vendors', 'view');
  if (!authz.ok) return deniedResponse(authz);

  const statusParam = req.nextUrl.searchParams.get('status');
  const status: VendorInvoiceStatus | undefined =
    statusParam === 'pending' || statusParam === 'paid' ? statusParam : undefined;

  const { rows, error } = await listOrphanageVendorInvoices({ status });
  if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
  return NextResponse.json({ rows, error: null });
}

/** POST /api/orphanage-vendor-invoices -> create a pending invoice. */
export async function POST(req: NextRequest) {
  const authz = await requireFeatureEdit('orphanage', 'third_party_vendors');
  if (!authz.ok) return deniedResponse(authz);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ row: null, error: 'Invalid JSON body' }, { status: 400 });
  }

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
    created_by: (body.created_by as string | null) ?? null,
  };

  const { row, error } = await createOrphanageVendorInvoice(input);
  if (error || !row) {
    // A duplicate invoice_number trips the unique index — surface it as a 409.
    const dup = error && /duplicate key|unique/i.test(error);
    return NextResponse.json(
      { row: null, error: dup ? 'That invoice number already exists' : (error ?? 'Insert failed') },
      { status: dup ? 409 : 500 },
    );
  }

  const actor = await getSessionActor();
  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'orphanage.vendor_invoice.created',
    resource: 'orphanage_vendor_invoices',
    resource_id: row.id,
    details: {
      invoice_number: row.invoice_number,
      vendor_name: row.vendor_name,
      total_amount: row.total_amount,
    },
  });

  return NextResponse.json({ row, error: null }, { status: 201 });
}
