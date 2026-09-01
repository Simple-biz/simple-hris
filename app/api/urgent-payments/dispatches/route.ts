import { NextResponse } from 'next/server';
import { deniedResponse, requireElevatedSession } from '@/lib/auth/authorize-email';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
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
//
// `is_one_off` (2026-09-01): true for rows created by a People-tab one-off
// payment (matched via `urgent_payment_requests.dispatch_id` — the breadcrumb
// the Send route stamps). One-off dispatch cards render inside the person's
// PROCESSOR bucket in Payment Dispatch, not under Urgent; MESA + orphanage
// stay Urgent. The flag lets both surfaces split ONE feed instead of growing
// two loaders that can disagree. Match failure degrades to `false` — the row
// then shows under Urgent (the pre-split home), never vanishes.
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
    const weekRows = all.filter((r) => r.cycle_source_file === sourceFile);

    const oneOffDispatchIds = new Set<string>();
    const supabase = createSupabaseServiceRoleClient();
    if (supabase && weekRows.length > 0) {
      const ids = weekRows.map((r) => String(r.id)).filter(Boolean);
      const { data } = await supabase
        .from('urgent_payment_requests')
        .select('dispatch_id')
        .in('dispatch_id', ids);
      for (const r of (data ?? []) as { dispatch_id: string | null }[]) {
        if (r.dispatch_id) oneOffDispatchIds.add(String(r.dispatch_id));
      }
    }

    const rows = weekRows.map((r) => ({ ...r, is_one_off: oneOffDispatchIds.has(String(r.id)) }));

    return NextResponse.json({ rows, week: sundayWeekRange(todayIso) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
