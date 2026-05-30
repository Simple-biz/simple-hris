import { NextResponse } from 'next/server';
import {
  listGiftPayments,
  replaceGiftPayments,
  type GiftPaymentDraft,
} from '@/lib/supabase/gift-payments';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';

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
      cycle?: {
        source_file?: string | null;
        period_start?: string | null;
        period_end?: string | null;
        fx_rate?: number | null;
      } | null;
    };
    if (!Array.isArray(body.records)) {
      return NextResponse.json({ error: 'Missing records[]' }, { status: 400 });
    }
    const { error } = await replaceGiftPayments(body.records, body.created_by ?? null);
    if (error) return NextResponse.json({ error }, { status: 500 });

    const totalUsd = body.records.reduce((sum, r) => {
      const v = typeof r.total_usd === 'number' ? r.total_usd : parseFloat(String(r.total_usd ?? '0'));
      return sum + (Number.isFinite(v) ? v : 0);
    }, 0);

    const actor = await getSessionActor();
    void insertAuditLog({
      user_name: body.created_by ?? actor.user_name,
      user_role: actor.user_role,
      action: 'gift.payment_edited',
      resource: 'gift_payments',
      resource_id: null,
      details: {
        record_count: body.records.length,
        total_usd: Number(totalUsd.toFixed(2)),
        cycle: body.cycle ?? null,
        periods: Array.from(
          new Set(
            body.records
              .map((r) => r.period_label)
              .filter((v): v is string => typeof v === 'string' && v.length > 0),
          ),
        ),
      },
    });

    return NextResponse.json({ error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
