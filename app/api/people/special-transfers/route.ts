import { NextRequest, NextResponse } from 'next/server';
import { authorizeEmailAccess, deniedResponse } from '@/lib/auth/authorize-email';
import { getPeoplePayrollHistory } from '@/lib/people/people-banking';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * One-off special transfers for a single employee, scoped to the session: an
 * employee sees only their own; an elevated viewer may pass `?email=` for anyone.
 * Powers the "Special transfers" card in the Employee Dashboard.
 */
export async function GET(req: NextRequest) {
  const requested = req.nextUrl.searchParams.get('email');
  const authz = await authorizeEmailAccess(requested);
  if (!authz.ok) return deniedResponse(authz);

  const { rows, error } = await getPeoplePayrollHistory(authz.effectiveEmail, 50);
  const transfers = rows.filter((r) => r.kind === 'special');
  return NextResponse.json({ transfers, error });
}
