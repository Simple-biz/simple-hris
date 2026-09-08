import { NextRequest, NextResponse } from 'next/server';
import { listBonusHistory } from '@/lib/supabase/bonus-catalog-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET ?bonusId= — every saved version of one bonus (newest first) plus every
 * assignment event on it. Same gate as the catalog GET beside it: any
 * authenticated employee may read (middleware gates /api); the tab that shows
 * it is permission-scoped.
 *
 * A failed read — including the history migration not having been applied — is
 * returned as `error` with empty lists, never as a silent empty history
 * (bonus-catalog.md §3.1.5).
 */
export async function GET(req: NextRequest) {
  const bonusId = req.nextUrl.searchParams.get('bonusId')?.trim();
  if (!bonusId) {
    return NextResponse.json({ versions: [], assignmentEvents: [], error: 'bonusId is required' }, { status: 400 });
  }
  try {
    const data = await listBonusHistory(bonusId);
    return NextResponse.json(data, { status: data.error ? 500 : 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ versions: [], assignmentEvents: [], error: msg }, { status: 500 });
  }
}
