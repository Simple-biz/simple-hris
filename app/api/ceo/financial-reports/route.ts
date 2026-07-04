import { NextResponse } from 'next/server';
import { requireRateVisibilitySession, deniedResponse } from '@/lib/auth/authorize-email';
import { buildFinancialReports, buildPeriodRecipients } from '@/lib/ceo/financial-reports';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Executive Financial Reports for the CEO dashboard — the company's payout
 * history over time (per pay-week payroll cost, cumulative growth, per-department
 * splits) read from `disbursement_records`.
 *
 *   GET /api/ceo/financial-reports                     → the full payout timeline
 *   GET /api/ceo/financial-reports?recipients=<file>   → recipient detail for one cycle
 *
 * Surfaces pay figures, so it is gated to RATE_VISIBLE_ROLES (admin / accounting
 * / ceo) — the same gate as the CEO overview + payments-live routes.
 */
export async function GET(request: Request) {
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);

  const { searchParams } = new URL(request.url);
  const recipientsFor = searchParams.get('recipients');

  try {
    if (recipientsFor) {
      const result = await buildPeriodRecipients(recipientsFor);
      return NextResponse.json(result);
    }
    const reports = await buildFinancialReports();
    return NextResponse.json(reports);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
