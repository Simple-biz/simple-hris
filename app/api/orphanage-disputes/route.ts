import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth/auth-options';
import {
  canActOnOrphanageManagerQueue,
  isOrphanageStyleReason,
  listDisputes,
  type PabDisputeStatus,
} from '@/lib/supabase/pab-day-disputes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Orphan-style rows that left the manager’s “awaiting review” queue — includes Accounting-final outcomes so the dashboard log stays complete. */
const ORPHANAGE_RECEIPT_LOG_STATUSES: readonly PabDisputeStatus[] = [
  'orphanage_manager_approved',
  'accounting_approved',
  'accounting_denied',
  'approved',
  'denied',
  'orphanage_manager_denied',
];

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

    // Pending + receipt log for the Orphanage Manager. Filter to orphanage-style
    // reasons (orphanage_visit + ceo_visitation) post-fetch — listDisputes only takes
    // a single `reason` value so we drop that constraint and gate in JS.
    const pendingQ = listDisputes({
      status: 'pending_orphanage_manager',
      limit: 500,
    });
    const verifiedQ = listDisputes({
      statuses: [...ORPHANAGE_RECEIPT_LOG_STATUSES],
      limit: 800,
      orderBy: { column: 'updated_at', ascending: false },
    });

    if (section === 'pending') {
      const { rows, error } = await pendingQ;
      if (error) return NextResponse.json({ pending: [], verified: [], error }, { status: 500 });
      return NextResponse.json({ pending: rows.filter((r) => isOrphanageStyleReason(r.reason)), verified: [], error: null });
    }
    if (section === 'verified') {
      const { rows, error } = await verifiedQ;
      if (error) return NextResponse.json({ pending: [], verified: [], error }, { status: 500 });
      return NextResponse.json({ pending: [], verified: rows.filter((r) => isOrphanageStyleReason(r.reason)), error: null });
    }

    const [pRes, vRes] = await Promise.all([pendingQ, verifiedQ]);
    const error = pRes.error ?? vRes.error;
    if (error) return NextResponse.json({ pending: [], verified: [], error }, { status: 500 });
    return NextResponse.json({
      pending: pRes.rows.filter((r) => isOrphanageStyleReason(r.reason)),
      verified: vRes.rows.filter((r) => isOrphanageStyleReason(r.reason)),
      error: null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ pending: [], verified: [], error: msg }, { status: 500 });
  }
}
