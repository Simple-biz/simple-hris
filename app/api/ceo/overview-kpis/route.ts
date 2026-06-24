import { NextResponse } from 'next/server';
import { requireRateVisibilitySession, deniedResponse } from '@/lib/auth/authorize-email';
import { buildCeoOverviewKpis } from '@/lib/ceo/overview-kpis';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Executive KPIs for the CEO overview: headcount per department, the current
 * pay week + payments to send, and unpaid workers from the last pay cycle.
 * Surfaces pay-related figures, so it's gated to RATE_VISIBLE_ROLES
 * (admin / accounting / ceo).
 */
export async function GET() {
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);
  try {
    const kpis = await buildCeoOverviewKpis();
    return NextResponse.json(kpis);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
