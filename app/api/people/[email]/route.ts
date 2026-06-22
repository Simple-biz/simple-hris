import { NextResponse } from 'next/server';
import { requireRateVisibilitySession, deniedResponse } from '@/lib/auth/authorize-email';
import { getPeopleBanking, getPeoplePayrollHistory } from '@/lib/people/people-banking';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Detail for one person: their payout details (MASKED — account numbers / SWIFT /
 * processor emails are redacted; use the reveal-banking endpoint to unmask with
 * an audit entry) plus their full payroll history (regular cycles + special
 * transfers). Gated to RATE_VISIBLE_ROLES.
 */
export async function GET(
  _req: Request,
  context: { params: Promise<{ email: string }> },
) {
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);

  const { email: raw } = await context.params;
  const email = decodeURIComponent(raw ?? '').trim();
  if (!email) return NextResponse.json({ error: 'Missing email' }, { status: 400 });

  const [{ banking, error: bankErr }, { rows: history, error: histErr }] = await Promise.all([
    getPeopleBanking(email, false),
    getPeoplePayrollHistory(email),
  ]);

  return NextResponse.json({
    banking,
    history,
    error: bankErr ?? histErr ?? null,
  });
}
