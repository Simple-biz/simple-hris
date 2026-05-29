import { NextRequest, NextResponse } from 'next/server';
import { getCycleAuditTrailBySourceFile } from '@/lib/audit/cycle-audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/payroll-wizard/audit?source_file=...&period_start=YYYY-MM-DD&period_end=YYYY-MM-DD
 *
 * Wizard-scoped audit fetch. The wizard knows the active Hubstaff filename
 * (cycle key) but may not yet have a `cycleId` (disbursement records aren't
 * persisted until dispatch), so this endpoint accepts source_file directly.
 *
 * Returns every audit event tied to the cycle — wizard.opened, edits,
 * contractor decisions, orphanage approvals, dispatches, lock toggles —
 * ordered oldest-first for the Step 9 Reports timeline.
 */
export async function GET(req: NextRequest) {
  const sourceFile = req.nextUrl.searchParams.get('source_file');
  const periodStart = req.nextUrl.searchParams.get('period_start');
  const periodEnd = req.nextUrl.searchParams.get('period_end');

  if (!sourceFile || !sourceFile.trim()) {
    return NextResponse.json(
      { bundle: null, error: 'Missing source_file' },
      { status: 400 },
    );
  }

  const { bundle, error } = await getCycleAuditTrailBySourceFile({
    sourceFile,
    periodStart,
    periodEnd,
  });
  if (error || !bundle) {
    return NextResponse.json(
      { bundle: null, error: error ?? 'Audit trail not available' },
      { status: 500 },
    );
  }

  return NextResponse.json({ bundle, error: null });
}
