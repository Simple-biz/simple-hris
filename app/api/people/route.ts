import { NextRequest, NextResponse } from 'next/server';
import { requireRateVisibilitySession, deniedResponse } from '@/lib/auth/authorize-email';
import { buildPeopleRoster } from '@/lib/people/people-roster';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * People roster for Accounting + CEO — name, department, hours this week,
 * overtime projection, pay rate, processor, a has-banking flag, and week-level OT
 * KPIs. Optional `?source_file=` scopes hours/OT to a specific Hubstaff upload
 * (the CSV period selector); omitted = the current initialized week. Optional
 * `?start=YYYY-MM-DD&end=YYYY-MM-DD` instead aggregates hours/OT across every
 * payroll week overlapping that custom range (the calendar date-range picker) and
 * takes precedence over `source_file`. Carries pay rates, so it is gated to
 * RATE_VISIBLE_ROLES (admin / accounting / ceo).
 */
export async function GET(req: NextRequest) {
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);

  const params = req.nextUrl.searchParams;
  const sourceFile = params.get('source_file')?.trim() || undefined;
  const rangeStart = params.get('start')?.trim() || undefined;
  const rangeEnd = params.get('end')?.trim() || undefined;
  const { rows, sourceFile: resolved, summary, range, error } = await buildPeopleRoster({
    sourceFile,
    rangeStart,
    rangeEnd,
  });
  return NextResponse.json({ rows, sourceFile: resolved, summary, range, error });
}
