import { NextRequest, NextResponse } from 'next/server';
import { getWeekAuditEvents } from '@/lib/payroll-wizard/tutorial/week-audit';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireRateVisibilityOrFeatureEdit } from '@/lib/auth/authorize-feature';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * [WIZARD-TUTORIAL] GET /api/payroll-wizard/audit-week?window_start=ISO&window_end=ISO
 *
 * Week-scoped audit fetch for the Reports step's Processing Narrative. The
 * window is a calendar Sun–Sat payroll week computed by the CLIENT (explicit
 * instants — no server timezone guessing) and is capped at one week.
 *
 * Same gate as the sibling per-cycle audit route: these events carry pay
 * amounts, so a signed-in employee with no payroll role gets nothing.
 */
export async function GET(req: NextRequest) {
  const authz = await requireRateVisibilityOrFeatureEdit('accounting', 'payment_dispatch');
  if (!authz.ok) return deniedResponse(authz);

  const windowStart = req.nextUrl.searchParams.get('window_start');
  const windowEnd = req.nextUrl.searchParams.get('window_end');
  if (!windowStart || !windowEnd) {
    return NextResponse.json(
      { events: null, error: 'Missing window_start / window_end' },
      { status: 400 },
    );
  }

  const { events, error } = await getWeekAuditEvents(windowStart, windowEnd);
  if (error || !events) {
    const badInput =
      error != null &&
      (error.includes('ISO instants') || error.includes('after window_start') || error.includes('exceed'));
    return NextResponse.json(
      { events: null, error: error ?? 'Audit trail not available' },
      { status: badInput ? 400 : 500 },
    );
  }

  return NextResponse.json({ events, error: null });
}
