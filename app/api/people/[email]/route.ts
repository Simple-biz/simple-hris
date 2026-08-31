import { NextResponse } from 'next/server';
import { requireRateVisibilitySession, deniedResponse } from '@/lib/auth/authorize-email';
import { getPeopleBanking, getPeoplePayrollHistory } from '@/lib/people/people-banking';
import { getPeopleBankHistory } from '@/lib/supabase/bank-update-history';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Detail for one person: their payout details (MASKED — account numbers / SWIFT /
 * processor emails are redacted; use the reveal-banking endpoint to unmask with
 * an audit entry), their full payroll history (regular cycles + special
 * transfers), and their bank/payout CHANGE history (masked before→after per
 * self-service edit). Gated to RATE_VISIBLE_ROLES.
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

  const [
    { banking, error: bankErr },
    { rows: history, error: histErr },
    { rows: bankHistory, error: bankHistErr },
  ] = await Promise.all([
    getPeopleBanking(email, false),
    getPeoplePayrollHistory(email),
    getPeopleBankHistory(email),
  ]);

  return NextResponse.json({
    banking,
    // Did the BANKING read actually resolve? `banking: null` is ambiguous on its
    // own — it means both "read failed" and "this person has no employee_ids row
    // and no rail in any tier", and those two demand opposite WIRES-lock
    // verdicts (fail closed vs. genuinely assignable, §4). The combined `error`
    // below cannot answer it either, since a history failure would poison it.
    bankingResolved: bankErr == null,
    history,
    bankHistory,
    error: bankErr ?? histErr ?? bankHistErr ?? null,
  });
}
