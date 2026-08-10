import { NextRequest, NextResponse } from 'next/server';
import { getCycleAuditTrail } from '@/lib/audit/cycle-audit';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireRateVisibilityOrFeatureEdit } from '@/lib/auth/authorize-feature';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/payment-dispatches/reports/[cycleId]/audit
 *
 * Returns every audit event tied to the cycle — wizard.opened, edits,
 * contractor decisions, orphanage approvals, dispatches, lock toggles —
 * ordered oldest-first for the Reports tab timeline.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ cycleId: string }> },
) {
  // Cycle payout data (amounts, and in the CSV exports full bank account
  // numbers + SWIFT). Same gate the write siblings on this tree use, so a
  // signed-in employee with no payroll role can no longer pull it.
  const authz = await requireRateVisibilityOrFeatureEdit('accounting', 'payment_dispatch');
  if (!authz.ok) return deniedResponse(authz);
  const { cycleId } = await params;
  if (!cycleId) {
    return NextResponse.json({ bundle: null, error: 'Missing cycleId' }, { status: 400 });
  }

  const { bundle, error } = await getCycleAuditTrail(cycleId);
  if (error || !bundle) {
    return NextResponse.json(
      { bundle: null, error: error ?? 'Audit trail not available' },
      { status: error?.toLowerCase().includes('not found') ? 404 : 500 },
    );
  }

  return NextResponse.json({ bundle, error: null });
}
