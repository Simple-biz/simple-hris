import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) return String((err as Record<string, unknown>).message);
  return errMsg(err);
}

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// GET /api/contractor/profile?email=...
export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get('email')?.toLowerCase().trim();
  if (!email) return NextResponse.json({ profile: null });
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from('contractor_profiles')
      .select('*')
      .eq('contractor_email', email)
      .maybeSingle();
    if (error) throw error;
    return NextResponse.json({ profile: data ?? null });
  } catch (err) {
    return NextResponse.json({ error: errMsg(err), profile: null }, { status: 500 });
  }
}

// POST /api/contractor/profile  — upsert by contractor_email
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as Record<string, unknown>;
    const email = String(body.contractor_email ?? '').toLowerCase().trim();
    if (!email) return NextResponse.json({ error: 'Missing contractor_email' }, { status: 400 });

    const supabase = getServiceClient();
    const { error } = await supabase
      .from('contractor_profiles')
      .upsert(
        {
          contractor_email:        email,
          display_name:            body.display_name             ?? null,
          logo_data_url:           body.logo_data_url            ?? null,
          // Invoice "From" details
          from_entity_name:        body.from_entity_name         ?? null,
          from_name:               body.from_name                ?? null,
          from_address:            body.from_address             ?? null,
          from_city_state_zip:     body.from_city_state_zip      ?? null,
          from_country:            body.from_country             ?? null,
          currency:                body.currency === 'USD' ? 'USD' : 'PHP',
          // Payment gateway
          preferred_processor:     body.preferred_processor      ?? null,
          preferred_bank_slot:     body.preferred_bank_slot      ?? 'primary',
          hurupay_email:           body.hurupay_email            ?? null,
          wepay_email:             body.wepay_email              ?? null,
          higlobe_email:           body.higlobe_email            ?? null,
          higlobe_account_name:    body.higlobe_account_name     ?? null,
          wise_email:              body.wise_email               ?? null,
          wise_tag:                body.wise_tag                 ?? null,
          phone_number:            body.phone_number             ?? null,
          full_address:            body.full_address             ?? null,
          bank_name:               body.bank_name                ?? null,
          account_holder_name:     body.account_holder_name      ?? null,
          account_number:          body.account_number           ?? null,
          swift_code:              body.swift_code               ?? null,
          alt_bank_name:           body.alt_bank_name            ?? null,
          alt_account_holder_name: body.alt_account_holder_name  ?? null,
          alt_account_number:      body.alt_account_number       ?? null,
          alt_routing_number:      body.alt_routing_number       ?? null,
        },
        { onConflict: 'contractor_email' },
      );
    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: errMsg(err) }, { status: 500 });
  }
}

// PATCH /api/contractor/profile  — partial update of a single contractor's
// invoicing currency. Kept separate from POST so admins can set the currency
// without overwriting the contractor's own profile fields (and vice versa).
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json() as Record<string, unknown>;
    const email = String(body.contractor_email ?? '').toLowerCase().trim();
    if (!email) return NextResponse.json({ error: 'Missing contractor_email' }, { status: 400 });
    const currency = body.currency === 'USD' ? 'USD' : 'PHP';

    const supabase = getServiceClient();
    const { error } = await supabase
      .from('contractor_profiles')
      .upsert({ contractor_email: email, currency }, { onConflict: 'contractor_email' });
    if (error) throw error;
    return NextResponse.json({ success: true, currency });
  } catch (err) {
    return NextResponse.json({ error: errMsg(err) }, { status: 500 });
  }
}
