import { NextResponse } from 'next/server';
import { requireElevatedSession, deniedResponse } from '@/lib/auth/authorize-email';
import { fetchGmlStatusMap } from '@/lib/roster/gml-status';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Bulk email -> Global Master List status (active vs offboarded + reason),
 *  sourced from global_master_list directly (see fetchGmlStatusMap doc for
 *  why /api/employees' active_employees view can't be used for this). */
export async function GET() {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const { map, error } = await fetchGmlStatusMap();
  if (error) return NextResponse.json({ statuses: [], error }, { status: 500 });

  const statuses = Array.from(map.entries()).map(([email, s]) => ({
    email,
    active: s.active,
    offBoardedAt: s.offBoardedAt,
    offBoardedReason: s.offBoardedReason,
  }));
  return NextResponse.json({ statuses, error: null });
}
