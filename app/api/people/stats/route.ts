import { NextResponse } from 'next/server';
import { requireRateVisibilitySession, deniedResponse } from '@/lib/auth/authorize-email';
import { buildPeopleStats } from '@/lib/people/people-roster';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Weekly OT trend for the People → Statistics tab: one point per recent payroll
 * week with OT payout (USD/PHP) and the number of people on overtime. Carries
 * pay figures, so it is gated to RATE_VISIBLE_ROLES (admin / accounting / ceo).
 */
export async function GET() {
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);

  const { points, error } = await buildPeopleStats();
  return NextResponse.json({ points, error });
}
