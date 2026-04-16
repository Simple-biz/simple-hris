import { NextResponse } from 'next/server';
import { listDisputes, createDispute, type PabDisputeStatus } from '@/lib/supabase/pab-day-disputes';
import { normEmail } from '@/lib/email/norm-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const email = searchParams.get('email') ?? undefined;
    const from = searchParams.get('from') ?? undefined;
    const to = searchParams.get('to') ?? undefined;
    const status = searchParams.get('status') as PabDisputeStatus | undefined;
    const limitRaw = searchParams.get('limit');
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;

    const { rows, error } = await listDisputes({ email, from, to, status, limit });
    if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
    return NextResponse.json({ rows, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ rows: [], error: msg }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      work_email?: string;
      dispute_date?: string;
      reason?: string;
      explanation?: string | null;
      created_by?: string | null;
    };

    const work_email = normEmail(body.work_email ?? '') ?? body.work_email?.trim().toLowerCase();
    if (!work_email) {
      return NextResponse.json({ error: 'work_email is required' }, { status: 400 });
    }

    const dispute_date = body.dispute_date?.trim();
    if (!dispute_date || !/^\d{4}-\d{2}-\d{2}$/.test(dispute_date)) {
      return NextResponse.json({ error: 'dispute_date is required (YYYY-MM-DD)' }, { status: 400 });
    }

    const reason = body.reason?.trim();
    if (!reason) {
      return NextResponse.json({ error: 'reason is required' }, { status: 400 });
    }

    const { id, error } = await createDispute({
      work_email,
      dispute_date,
      reason,
      explanation: body.explanation,
      created_by: body.created_by,
    });

    if (error) return NextResponse.json({ error }, { status: error.includes('already exists') ? 409 : 500 });
    return NextResponse.json({ success: true, id, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
