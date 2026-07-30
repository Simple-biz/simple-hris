import { NextResponse } from 'next/server';
import { deniedResponse, requireElevatedSession } from '@/lib/auth/authorize-email';
import { loadUrgentDispatchRows } from '@/lib/payroll/disbursement-reports';
import { sundayWeekRange, urgentCycleSourceFile } from '@/lib/payroll/urgent-cycle';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/urgent-payments/dispatches
// Urgent payouts ALREADY logged this Sun→Sat week — the Paid / Not paid /
// Threshold / Problem side of the Urgent bucket. Pending requests come from
// /api/urgent-payments (MESA) + /requests (one-off) + /api/orphanage-dispatches;
// this route completes the picture so the bucket doesn't vanish the moment the
// last pending item is dispatched. Reuses the weekly report's loader
// (loadUrgentDispatchRows) so these views and the Urgent report always agree,
// then keeps only the current week's bucket (history stays in Reports).
// Accounting / payroll-clerk only.
export async function GET() {
  try {
    const authz = await requireElevatedSession();
    if (!authz.ok) return deniedResponse(authz);

    // Same UTC day the dispatch writers use to bucket a sent payment, so "this
    // week" here is exactly the bucket today's dispatches land in.
    const todayIso = new Date().toISOString().slice(0, 10);
    const sourceFile = urgentCycleSourceFile(todayIso);

    const all = await loadUrgentDispatchRows();
    const rows = all.filter((r) => r.cycle_source_file === sourceFile);

    return NextResponse.json({ rows, week: sundayWeekRange(todayIso) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
