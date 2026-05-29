import { NextRequest, NextResponse } from 'next/server';
import {
  getCycleAuditTrailBySourceFile,
  cycleAuditCsv,
  cycleAuditFilename,
} from '@/lib/audit/cycle-audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/payroll-wizard/audit/export?source_file=...&period_start=...&period_end=...
 *
 * CSV download of the audit trail for the wizard's active cycle. Same shape
 * as the disbursement-report audit export.
 */
export async function GET(req: NextRequest) {
  const sourceFile = req.nextUrl.searchParams.get('source_file');
  const periodStart = req.nextUrl.searchParams.get('period_start');
  const periodEnd = req.nextUrl.searchParams.get('period_end');

  if (!sourceFile || !sourceFile.trim()) {
    return NextResponse.json({ error: 'Missing source_file' }, { status: 400 });
  }

  const { bundle, error } = await getCycleAuditTrailBySourceFile({
    sourceFile,
    periodStart,
    periodEnd,
  });
  if (error || !bundle) {
    return NextResponse.json(
      { error: error ?? 'Audit trail not available' },
      { status: 500 },
    );
  }

  const csv = cycleAuditCsv(bundle.events);
  const filename = cycleAuditFilename(
    bundle.sourceFile ?? 'wizard',
    bundle.periodStart,
    bundle.periodEnd,
  );

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
