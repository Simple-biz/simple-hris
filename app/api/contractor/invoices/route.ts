import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// GET /api/contractor/invoices?email=...
export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get('email')?.toLowerCase().trim();
  if (!email) return NextResponse.json({ invoices: [] });
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from('contractor_invoices')
      .select('*')
      .eq('contractor_email', email)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return NextResponse.json({ invoices: data ?? [] });
  } catch (err) {
    return NextResponse.json({ error: String(err), invoices: [] }, { status: 500 });
  }
}

// POST /api/contractor/invoices
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from('contractor_invoices')
      .insert({
        contractor_email: String(body.contractorEmail ?? '').toLowerCase().trim(),
        invoice_number: body.invoiceNumber ?? '',
        invoice_date: body.invoiceDate ?? '',
        due_date: body.dueDate ?? '',
        from_company: body.fromCompany ?? '',
        from_name: body.fromName ?? '',
        from_address: body.fromAddress ?? '',
        from_city_state_zip: body.fromCityStateZip ?? '',
        from_country: body.fromCountry ?? 'Philippines',
        to_company: body.toCompany ?? '',
        to_address: body.toAddress ?? '',
        to_city_state_zip: body.toCityStateZip ?? '',
        to_country: body.toCountry ?? '',
        line_items: body.lineItems ?? [],
        notes: body.notes ?? '',
        terms: body.terms ?? '',
        subtotal: body.subtotal ?? 0,
        tax_total: body.taxTotal ?? 0,
        total: body.total ?? 0,
      })
      .select()
      .single();
    if (error) throw error;
    return NextResponse.json({ success: true, invoice: data });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// DELETE /api/contractor/invoices?id=...
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  try {
    const supabase = getServiceClient();
    const { error } = await supabase.from('contractor_invoices').delete().eq('id', id);
    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
