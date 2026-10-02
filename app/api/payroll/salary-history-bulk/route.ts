import { NextResponse } from 'next/server';
import { requireRateVisibilitySession, deniedResponse } from '@/lib/auth/authorize-email';
import { listAllSalaryHistory } from '@/lib/supabase/salary-history-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/payroll/salary-history-bulk — every `employee_salary_history` row (the dated pay-basis
 * timeline, docs/features/salaried-pay-basis.md), newest first. The Payroll Wizard resolves each
 * person's basis for the selected week from it, the same way the server's computeCurrentPay does.
 * Pay data → gated exactly like its sibling `rate-history-bulk` (admin / accounting / ceo).
 *
 * `state` is never guessed: `not_configured` (the migration has not been applied — nobody can be
 * salaried), `unavailable` (the read failed — the wizard then HOLDS every salaried person rather
 * than price them hourly), or `loaded`. Paged inside `listAllSalaryHistory`.
 */
export async function GET() {
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);

  const { rows, state, error } = await listAllSalaryHistory();
  if (state === 'unavailable') {
    return NextResponse.json({ rows: [], state, error }, { status: 500 });
  }
  return NextResponse.json({ rows, state, error: null });
}
