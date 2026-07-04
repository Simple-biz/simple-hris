import { NextRequest, NextResponse } from 'next/server';
import { requireElevatedSession, deniedResponse } from '@/lib/auth/authorize-email';
import { getScreeningPage } from '@/lib/supabase/screening-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Returns a page of the active screening board (latest-scanned first), with an
 * optional `q` search. Elevated-session only — HR/admin/accounting/CEO. The HR
 * "Screening" tab reads this; the Sync button posts to
 * /api/cron/sync-screening-from-sheet.
 *
 * Query: ?page=0&pageSize=25&q=foo  → { rows, total, page, pageSize }
 */
export async function GET(req: NextRequest) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const sp = req.nextUrl.searchParams;
  const page = Number(sp.get('page') ?? '0');
  const pageSize = Number(sp.get('pageSize') ?? '25');
  const q = sp.get('q') ?? '';

  try {
    const result = await getScreeningPage({ page, pageSize, q });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[GET /api/screening]', msg);
    return NextResponse.json({ rows: [], total: 0, page: 0, pageSize: 25, error: msg }, { status: 500 });
  }
}
