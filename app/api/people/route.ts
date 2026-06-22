import { NextResponse } from 'next/server';
import { requireRateVisibilitySession, deniedResponse } from '@/lib/auth/authorize-email';
import { buildPeopleRoster } from '@/lib/people/people-roster';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * People roster for Accounting + CEO — name, department, hours this week,
 * overtime projection, pay rate, processor, and a has-banking flag. Carries pay
 * rates, so it is gated to RATE_VISIBLE_ROLES (admin / accounting / ceo).
 */
export async function GET() {
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);

  const { rows, sourceFile, error } = await buildPeopleRoster();
  return NextResponse.json({ rows, sourceFile, error });
}
