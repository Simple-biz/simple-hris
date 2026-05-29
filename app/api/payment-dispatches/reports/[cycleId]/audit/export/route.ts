import { NextRequest, NextResponse } from 'next/server';
import {
  getCycleAuditTrail,
  cycleAuditCsv,
  cycleAuditFilename,
} from '@/lib/audit/cycle-audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/payment-dispatches/reports/[cycleId]/audit/export
 *
 * CSV download of the cycle's audit trail. Columns:
 *   Timestamp, User, Role, Action, Resource, Resource ID, Employee, Field,
 *   Old value, New value, Amount (USD), Amount (PHP), FX rate, Cycle file,
 *   Matched via, IP, Full details (JSON).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ cycleId: string }> },
) {
  const { cycleId } = await params;
  if (!cycleId) {
    return NextResponse.json({ error: 'Missing cycleId' }, { status: 400 });
  }

  const { bundle, error } = await getCycleAuditTrail(cycleId);
  if (error || !bundle) {
    return NextResponse.json(
      { error: error ?? 'Audit trail not available' },
      { status: error?.toLowerCase().includes('not found') ? 404 : 500 },
    );
  }

  const csv = cycleAuditCsv(bundle.events);
  const filename = cycleAuditFilename(cycleId, bundle.periodStart, bundle.periodEnd);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
