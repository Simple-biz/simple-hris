import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { requireRateVisibilityOrFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { loadContractorDispatchRows } from '@/lib/contractor/contractor-dispatch-queue';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/contractor/dispatch-queue?source_file=…&fx=…
 *
 * The contractor half of the Payment Dispatch queue: one row per approved,
 * unclaimed contractor invoice, resolved onto the same processor tabs and the
 * same payout-detail shape as employee rows.
 *
 * Gated identically to the other dispatch-queue reads (/api/payment-dispatches,
 * /api/current-cycle): rate-visible roles OR an admin-granted Edit on Payment
 * Dispatch. This route exists precisely BECAUSE it must be gated —
 * GET /api/contractor/invoices has no authorization at all, so reading invoices
 * from the client would expose contractor banking to any signed-in user.
 *
 * Errors return HTTP 200 with empty rows + an `error` string: the caller merges
 * this into the employee queue, and a contractor-side failure must never blank
 * out employee payroll.
 */
export async function GET(req: NextRequest) {
  const authz = await requireRateVisibilityOrFeatureEdit('accounting', 'payment_dispatch');
  if (!authz.ok) return deniedResponse(authz);

  const sourceFile = req.nextUrl.searchParams.get('source_file')?.trim() || null;
  const fxRaw = Number(req.nextUrl.searchParams.get('fx') ?? '0');
  const fxRate = Number.isFinite(fxRaw) && fxRaw > 0 ? fxRaw : 0;

  try {
    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) {
      return NextResponse.json({ active: [], excluded: [], contractorEmails: [], error: 'Supabase client unavailable' });
    }
    const result = await loadContractorDispatchRows(supabase, { sourceFile, fxRate });
    // Two distinct channels, because they need opposite UI copy:
    //   error    — the contractor half is MISSING (migration, cycle, read failure)
    //   advisory — the load SUCCEEDED but something needs attention (stuck invoices)
    const { notice, advisory, ...rest } = result;
    return NextResponse.json({ ...rest, error: notice ?? null, advisory: advisory ?? null });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ active: [], excluded: [], contractorEmails: [], error });
  }
}
