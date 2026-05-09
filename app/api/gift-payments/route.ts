import { NextResponse } from 'next/server';
import {
  listGiftPayments,
  replaceGiftPayments,
  type GiftPaymentDraft,
} from '@/lib/supabase/gift-payments';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = searchParams.get('email');
  const { rows, error } = await listGiftPayments({ email });
  if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
  return NextResponse.json({ rows, error: null });
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as {
      records?: GiftPaymentDraft[];
      created_by?: string | null;
    };
    if (!Array.isArray(body.records)) {
      return NextResponse.json({ error: 'Missing records[]' }, { status: 400 });
    }
    const { error } = await replaceGiftPayments(body.records, body.created_by ?? null);
    if (error) return NextResponse.json({ error }, { status: 500 });
    return NextResponse.json({ error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
