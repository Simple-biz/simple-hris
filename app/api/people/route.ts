import { NextRequest, NextResponse } from 'next/server';
import { requireRateVisibilitySession, deniedResponse } from '@/lib/auth/authorize-email';
import { buildPeopleRoster } from '@/lib/people/people-roster';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * People roster for Accounting + CEO — name, department, hours this week,
 * overtime projection, pay rate, processor, a has-banking flag, and week-level OT
 * KPIs. Optional `?source_file=` scopes hours/OT to a specific Hubstaff upload
 * (the CSV period selector); omitted = the current initialized week. Carries pay
 * rates, so it is gated to RATE_VISIBLE_ROLES (admin / accounting / ceo).
 */
export async function GET(req: NextRequest) {
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);

  const sourceFile = req.nextUrl.searchParams.get('source_file')?.trim() || undefined;
  const { rows, sourceFile: resolved, summary, error } = await buildPeopleRoster(sourceFile);
  return NextResponse.json({ rows, sourceFile: resolved, summary, error });
}
