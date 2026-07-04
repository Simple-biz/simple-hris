import { NextRequest, NextResponse } from 'next/server';
import { requireElevatedSession, deniedResponse } from '@/lib/auth/authorize-email';
import { getScreeningPage, getScreeningCount } from '@/lib/supabase/screening-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The HR "Screening" tab reads here (Sync posts to /api/cron/sync-screening-from-sheet).
 * Elevated-session only — HR/admin/accounting/CEO.
 *
 * Two modes so the table paints fast on a ~50k-row board:
 *   ?page=0&pageSize=100&q=foo → { rows, page, pageSize }   (fast, indexed LIMIT scan, NO count)
 *   ?count=1&q=foo             → { total }                  (background exact count)
 */
export async function GET(req: NextRequest) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const sp = req.nextUrl.searchParams;
  const q = sp.get('q') ?? '';

  if (sp.get('count')) {
    try {
      const total = await getScreeningCount(q);
      return NextResponse.json({ total });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[GET /api/screening?count]', msg);
      return NextResponse.json({ total: 0, error: msg }, { status: 500 });
    }
  }

  const page = Number(sp.get('page') ?? '0');
  const pageSize = Number(sp.get('pageSize') ?? '100');
  try {
    const result = await getScreeningPage({ page, pageSize, q });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[GET /api/screening]', msg);
    return NextResponse.json({ rows: [], page: 0, pageSize: 100, error: msg }, { status: 500 });
  }
}
