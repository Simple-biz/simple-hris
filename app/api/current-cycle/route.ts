import { NextRequest, NextResponse } from "next/server";
import {
  createSupabaseServiceRoleClient,
  createSupabaseServerClient,
} from "@/lib/supabase/server";
import {
  getCurrentHubstaffUploadId,
  getHubstaffUploadIdBySourceFile,
} from "@/lib/supabase/hubstaff-hours-db";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireRateVisibilityOrFeatureEdit } from "@/lib/auth/authorize-feature";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Lightweight lookup of the current Hubstaff upload id (the pay cycle id).
 *
 * The Payment Dispatch queue needs the cycle id to fetch which recipients were
 * already paid. That id is also returned by the much heavier
 * /api/payroll-current-pay, but waiting for that endpoint just to learn the
 * cycle id forces the dispatches fetch to run AFTER it. Exposing the id on its
 * own (a single-row query) lets the client fetch dispatches in parallel with
 * the pay computation instead of behind it.
 */
export async function GET(req: NextRequest) {
  // Resolves a pay-cycle id (and, with `?source_file=`, the id for any past
  // week). It only returns a UUID, but it feeds the dispatch screen, so gate it
  // identically to the other dispatch-queue reads: rate-visible roles OR an
  // admin-granted Edit on Payment Dispatch.
  const authz = await requireRateVisibilityOrFeatureEdit("accounting", "payment_dispatch");
  if (!authz.ok) return deniedResponse(authz);

  // `?source_file=` resolves the cycle id for a PAST week (so Payment Dispatch
  // can fetch that week's already-paid dispatches). Absent → the current cycle.
  const sourceFileRaw = req.nextUrl.searchParams.get("source_file");
  const sourceFile = sourceFileRaw?.trim() ? sourceFileRaw.trim() : null;
  try {
    const supabase =
      createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    const cycleId = supabase
      ? sourceFile
        ? await getHubstaffUploadIdBySourceFile(supabase, sourceFile)
        : await getCurrentHubstaffUploadId(supabase)
      : null;
    return NextResponse.json({ cycleId, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ cycleId: null, error: msg }, { status: 500 });
  }
}
