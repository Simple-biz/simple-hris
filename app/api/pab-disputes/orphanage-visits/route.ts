import { NextResponse } from 'next/server';
import {
  listDisputes,
  adminCreateOrphanageVisit,
} from '@/lib/supabase/pab-day-disputes';
import { normEmail } from '@/lib/email/norm-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const from = searchParams.get('from') ?? undefined;
    const to = searchParams.get('to') ?? undefined;
    const limitRaw = searchParams.get('limit');
    const limit = limitRaw ? parseInt(limitRaw, 10) : 500;

    const { rows, error } = await listDisputes({ from, to, limit });
    if (error) return NextResponse.json({ rows: [], error }, { status: 500 });

    const filtered = rows.filter(
      (r) =>
        r.reason === 'orphanage_visit' &&
        (r.status === 'accounting_approved' || r.status === 'approved'),
    );
    return NextResponse.json({ rows: filtered, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ rows: [], error: msg }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      work_email?: string;
      visit_date?: string;
      note?: string | null;
      admin_name?: string;
    };

    const work_email = normEmail(body.work_email ?? '') ?? body.work_email?.trim().toLowerCase();
    if (!work_email) {
      return NextResponse.json({ error: 'work_email is required' }, { status: 400 });
    }

    const visit_date = body.visit_date?.trim();
    if (!visit_date || !/^\d{4}-\d{2}-\d{2}$/.test(visit_date)) {
      return NextResponse.json({ error: 'visit_date is required (YYYY-MM-DD)' }, { status: 400 });
    }

    const admin_name = body.admin_name?.trim();
    if (!admin_name) {
      return NextResponse.json({ error: 'admin_name is required' }, { status: 400 });
    }

    const { id, error } = await adminCreateOrphanageVisit({
      work_email,
      visit_date,
      note: body.note,
      admin_name,
    });

    if (error) return NextResponse.json({ error }, { status: 500 });
    return NextResponse.json({ success: true, id, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
