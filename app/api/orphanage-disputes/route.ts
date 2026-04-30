import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth/auth-options';
import {
  canActOnOrphanageManagerQueue,
  listDisputes,
} from '@/lib/supabase/pab-day-disputes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    const email = session?.user?.email?.trim().toLowerCase();
    if (!email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    if (!(await canActOnOrphanageManagerQueue(email))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const section = searchParams.get('section'); // pending | verified (optional; default = both)

    const pendingQ = listDisputes({
      reason: 'orphanage_visit',
      status: 'pending_orphanage_manager',
      limit: 500,
    });
    const verifiedQ = listDisputes({
      reason: 'orphanage_visit',
      status: 'orphanage_manager_approved',
      limit: 200,
      orderBy: { column: 'decided_at', ascending: false },
    });

    if (section === 'pending') {
      const { rows, error } = await pendingQ;
      if (error) return NextResponse.json({ pending: [], verified: [], error }, { status: 500 });
      return NextResponse.json({ pending: rows, verified: [], error: null });
    }
    if (section === 'verified') {
      const { rows, error } = await verifiedQ;
      if (error) return NextResponse.json({ pending: [], verified: [], error }, { status: 500 });
      return NextResponse.json({ pending: [], verified: rows, error: null });
    }

    const [pRes, vRes] = await Promise.all([pendingQ, verifiedQ]);
    const error = pRes.error ?? vRes.error;
    if (error) return NextResponse.json({ pending: [], verified: [], error }, { status: 500 });
    return NextResponse.json({ pending: pRes.rows, verified: vRes.rows, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ pending: [], verified: [], error: msg }, { status: 500 });
  }
}
