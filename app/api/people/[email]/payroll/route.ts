import { NextResponse } from 'next/server';
import { requireRateVisibilitySession, deniedResponse } from '@/lib/auth/authorize-email';
import { getPeoplePayWeeks } from '@/lib/people/people-banking';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/people/[email]/payroll: one person's pay, week by week, WITH the
 * bonuses. This feeds the People → Payroll tab in the popup and on the Search Bar
 * page (`docs/features/people-payroll-history.md`).
 *
 * Each week is headlined by the statement the worker was sent (Net pay, bonuses
 * itemised), else by what the paid dispatch rows sent, else by the weekly
 * record's hourly pay under that name. It is split from `GET /api/people/[email]`
 * so the banking read, which the popup, the Search Bar and the Payroll Wizard
 * all wait on, never waits on statement assembly. It is fetched when the Payroll
 * tab is first opened.
 *
 * Same gate as the rest of People: RATE_VISIBLE_ROLES (admin / accounting / ceo).
 * Deliberately NOT the statement modal's `accounting.payment_dispatch` feature
 * gate, which defaults to hidden and would lock the CEO out of a tab they already see.
 *
 * A failed read answers 500 with the reason, never an empty list: an empty
 * Payroll tab reads as "never paid".
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

  const { weeks, error } = await getPeoplePayWeeks(email);
  if (error) return NextResponse.json({ weeks: [], error }, { status: 500 });
  return NextResponse.json({ weeks, error: null });
}
