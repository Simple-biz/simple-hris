import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/auth-options';
import {
  canActOnDisputes,
  canActOnOrphanageManagerQueue,
  isOrphanageStyleReason,
  listDisputes,
  type PabDayDisputeRow,
} from '@/lib/supabase/pab-day-disputes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Returns existing orphanage-style disputes (orphanage_visit + ceo_visitation) so the
 * Create-Disputes dialog can render the active person's calendar with the *real* status
 * of each day — green for already-forgiven, amber for in-flight, red+disabled for denied.
 *
 * Auth: orphanage_manager OR any accounting role. Returns 403 otherwise. Intentionally
 * NOT gated through `authorizeEmailAccess` (which only knows about the ELEVATED_ROLES set,
 * which doesn't include orphanage_manager).
 *
 * Optional filters:
 *  - `from`, `to` (ISO YYYY-MM-DD): bounds the query.
 *  - `email`: scope to a single employee. Default = all employees.
 */
export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    const actorEmail = session?.user?.email?.trim().toLowerCase();
    if (!actorEmail) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const [isOrphMgr, isAccounting] = await Promise.all([
      canActOnOrphanageManagerQueue(actorEmail),
      canActOnDisputes(actorEmail),
    ]);
    if (!isOrphMgr && !isAccounting) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const from = searchParams.get('from') ?? undefined;
    const to = searchParams.get('to') ?? undefined;
    const email = searchParams.get('email') ?? undefined;
    const limitRaw = searchParams.get('limit');
    const limit = limitRaw ? parseInt(limitRaw, 10) : 2000;

    // Pull every dispute in range, then filter to orphanage-style. listDisputes can only
    // filter on a single `reason`; running two queries (one per code) and concat'ing would
    // double the round-trip — JS-side filtering is cheaper here.
    const { rows, error } = await listDisputes({ email, from, to, limit });
    if (error) return NextResponse.json({ rows: [], error }, { status: 500 });

    const filtered = (rows ?? []).filter((r: PabDayDisputeRow) => isOrphanageStyleReason(r.reason));
    return NextResponse.json({ rows: filtered, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ rows: [], error: msg }, { status: 500 });
  }
}
