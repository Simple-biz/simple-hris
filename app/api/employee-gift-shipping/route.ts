import { NextRequest, NextResponse } from 'next/server';
import {
  listShippingDetails,
  upsertShippingDetail,
  type UpsertShippingInput,
} from '@/lib/supabase/employee-gift-shipping';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET ?email=… — scope to one employee. Omit `email` to list everyone (Orphanage team view). */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const email = searchParams.get('email')?.trim() || null;
  const { rows, error } = await listShippingDetails({ personalEmail: email });
  if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
  return NextResponse.json({ rows, error: null });
}

/** PUT — employee submit/edit for a specific (personal_email, milestone_index). */
export async function PUT(req: NextRequest) {
  let body: UpsertShippingInput;
  try {
    body = (await req.json()) as UpsertShippingInput;
  } catch {
    return NextResponse.json({ row: null, error: 'Invalid JSON body' }, { status: 400 });
  }

  const required: (keyof UpsertShippingInput)[] = [
    'personal_email',
    'milestone_index',
    'milestone_date',
    'preferred_delivery_location',
    'active_contact_number',
  ];
  for (const k of required) {
    const v = body[k];
    if (v == null || (typeof v === 'string' && !v.trim())) {
      return NextResponse.json(
        { row: null, error: `Missing required field: ${String(k)}` },
        { status: 400 },
      );
    }
  }

  const { row, error } = await upsertShippingDetail(body);
  if (error || !row) {
    return NextResponse.json(
      { row: null, error: error ?? 'Insert failed' },
      { status: error?.includes('approved') ? 409 : 500 },
    );
  }
  return NextResponse.json({ row, error: null });
}
