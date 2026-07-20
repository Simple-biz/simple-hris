import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) return String((err as Record<string, unknown>).message);
  return String(err);
}

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// GET /api/contractor/invoices?email=...   → invoices for one contractor
// GET /api/contractor/invoices?status=...  → all invoices with that status (PayrollWizard)
// GET /api/contractor/invoices             → all invoices (admin)
export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get('email')?.toLowerCase().trim();
  const status = req.nextUrl.searchParams.get('status')?.trim();
  try {
    const supabase = getServiceClient();
    let q = supabase
      .from('contractor_invoices')
      .select('*')
      .order('created_at', { ascending: false });
    if (email) q = q.eq('contractor_email', email);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    return NextResponse.json({ invoices: data ?? [] });
  } catch (err) {
    return NextResponse.json({ error: errMsg(err), invoices: [] }, { status: 500 });
  }
}

// POST /api/contractor/invoices  → create invoice (status defaults to 'pending')
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const supabase = getServiceClient();

    // Optional payment rail attached to the invoice. Validated inline (no shared
    // import) so this server route stays free of the client payment module.
    const pm = body.paymentMethod;
    const paymentMethod =
      pm && typeof pm === 'object' &&
      ['hurupay', 'higlobe', 'wires', 'ach'].includes(pm.processor) &&
      ['global', 'us'].includes(pm.region)
        ? {
            region: pm.region,
            processor: pm.processor,
            fields: pm.fields && typeof pm.fields === 'object' ? pm.fields : {},
          }
        : null;

    const { data, error } = await supabase
      .from('contractor_invoices')
      .insert({
        contractor_email:  String(body.contractorEmail ?? '').toLowerCase().trim(),
        invoice_number:    body.invoiceNumber ?? '',
        invoice_date:      body.invoiceDate || null,
        due_date:          body.dueDate || null,
        from_entity_name:  body.fromEntityName ?? '',
        from_name:         body.fromName ?? '',
        from_address:      body.fromAddress ?? '',
        from_city_state_zip: body.fromCityStateZip ?? '',
        from_country:      body.fromCountry ?? 'Philippines',
        to_company:        body.toCompany ?? 'Simple.biz',
        to_address:        body.toAddress ?? 'Remote/USA',
        to_city_state_zip: body.toCityStateZip ?? '',
        to_country:        body.toCountry ?? 'USA',
        logo_data_url:     body.logoUrl ?? null,
        currency:          body.currency === 'USD' ? 'USD' : 'PHP',
        line_items:        body.lineItems ?? [],
        notes:             body.notes ?? '',
        subtotal:          body.subtotal ?? 0,
        tax_total:         body.taxTotal ?? 0,
        total:             body.total ?? 0,
        payment_method:    paymentMethod,
        status:            'pending',
      })
      .select()
      .single();
    if (error) throw error;
    return NextResponse.json({ success: true, invoice: data });
  } catch (err) {
    return NextResponse.json({ error: errMsg(err) }, { status: 500 });
  }
}

// DELETE /api/contractor/invoices?id=...&email=...
// Contractor retracts (withdraws) an invoice they sent to Accounting. Allowed
// ONLY while the invoice is still 'pending' — once Accounting has approved or
// rejected it, it can no longer be retracted. Scoped to the owner by email,
// matching the (unauthenticated) contractor-facing GET/POST on this route.
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')?.trim();
  const email = req.nextUrl.searchParams.get('email')?.toLowerCase().trim();
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  if (!email) return NextResponse.json({ error: 'Missing email' }, { status: 400 });
  try {
    const supabase = getServiceClient();

    const { data: row, error: fetchErr } = await supabase
      .from('contractor_invoices')
      .select('id, contractor_email, status, invoice_number, total, currency')
      .eq('id', id)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!row) return NextResponse.json({ error: 'Invoice not found.' }, { status: 404 });
    if (row.contractor_email !== email) {
      return NextResponse.json({ error: 'You can only retract your own invoices.' }, { status: 403 });
    }
    if (row.status !== 'pending') {
      return NextResponse.json(
        { error: `This invoice has already been ${row.status} by Accounting and can no longer be retracted.` },
        { status: 409 },
      );
    }

    // Race guard: only delete if it's STILL pending, so a retract can't clobber
    // an approval/rejection Accounting made between the fetch above and now.
    const { data: deleted, error: delErr } = await supabase
      .from('contractor_invoices')
      .delete()
      .eq('id', id)
      .eq('status', 'pending')
      .select('id');
    if (delErr) throw delErr;
    if (!deleted || deleted.length === 0) {
      return NextResponse.json(
        { error: 'This invoice was just reviewed by Accounting and can no longer be retracted.' },
        { status: 409 },
      );
    }

    // Best-effort audit trail — a retracted invoice is hard-deleted, so this row
    // is the only remaining record that it existed.
    let actorName = email;
    let actorRole = 'contractor';
    try {
      const actor = await getSessionActor();
      if (actor.user_name !== 'anonymous') actorName = actor.user_name;
      actorRole = actor.user_role;
    } catch {
      // ignore — audit trail is best-effort
    }
    void insertAuditLog({
      user_name: actorName,
      user_role: actorRole,
      action: 'contractor.retracted',
      resource: 'contractor_invoices',
      resource_id: id,
      details: {
        contractor_email: row.contractor_email,
        invoice_number: row.invoice_number ?? null,
        total: row.total ?? null,
        currency: row.currency ?? null,
      },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: errMsg(err) }, { status: 500 });
  }
}
