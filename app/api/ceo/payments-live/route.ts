import { NextResponse } from 'next/server';
import { requireRateVisibilitySession, deniedResponse } from '@/lib/auth/authorize-email';
import { buildPaymentsLive } from '@/lib/ceo/payments-live';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Live "payments to send" progress for the current pay cycle — total / paid /
 * remaining. The CEO Overview refetches this on every payment_dispatches
 * Realtime change so the card ticks down as workers are paid. Surfaces a pay
 * count, so it's gated to RATE_VISIBLE_ROLES (admin / accounting / ceo).
 */
export async function GET() {
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);
  try {
    const live = await buildPaymentsLive();
    return NextResponse.json(live);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { sourceFile: null, label: 'Current pay week', total: 0, paid: 0, remaining: 0, recent: [], error: msg },
      { status: 500 },
    );
  }
}
