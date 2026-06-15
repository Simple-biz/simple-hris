import { NextResponse } from "next/server";
import { listExcludedArrears } from "@/lib/supabase/paystub-dispatch-queue";
import { requireFeatureAccess } from "@/lib/auth/authorize-feature";
import { deniedResponse } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/paystub-dispatch-queue/arrears
 * Cross-cycle pending pay for held (wizard-excluded) employees — one entry per
 * employee with a running total + per-cycle breakdown. Drives the Payment
 * Dispatch Excluded tab's "what we owe" rollup. View-gated to the dispatch
 * audience (no bank creds / payload in the response).
 */
export async function GET() {
  const authz = await requireFeatureAccess("accounting", "payment_dispatch", "view");
  if (!authz.ok) return deniedResponse(authz);
  const { entries, error } = await listExcludedArrears();
  return NextResponse.json({ entries, error });
}
