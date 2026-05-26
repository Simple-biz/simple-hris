import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

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

// DELETE /api/contractor/invoices?id=...
// Invoices are sent to Accounting on creation and are not deletable afterwards.
export async function DELETE() {
  return NextResponse.json(
    { error: 'Invoices sent to Accounting cannot be deleted.' },
    { status: 403 },
  );
}
