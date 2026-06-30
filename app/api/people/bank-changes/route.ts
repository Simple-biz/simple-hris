import { NextRequest, NextResponse } from 'next/server';
import { requireRateVisibilitySession, deniedResponse } from '@/lib/auth/authorize-email';
import { fetchRecentBankChanges } from '@/lib/supabase/audit-log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Recent self-service bank/payout changes for the People-tab "Bank changes" feed
 * (Accounting + CEO). Newest first. Sourced from the append-only audit_log
 * (`bank_update.saved` events) — carries WHO + WHEN + WHICH FIELD NAMES +
 * processor, never the account values. Gated to RATE_VISIBLE_ROLES (admin /
 * accounting / ceo), matching the rest of the People surface (`/api/people`).
 */
export async function GET(req: NextRequest) {
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);

  const raw = parseInt(req.nextUrl.searchParams.get('limit') ?? '50', 10);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 200) : 50;

  try {
    const { rows, error } = await fetchRecentBankChanges(limit);
    if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
    return NextResponse.json({ rows, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ rows: [], error: msg }, { status: 500 });
  }
}
