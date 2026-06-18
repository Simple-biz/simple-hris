import { NextResponse } from "next/server";
import { revertHrPendingEmployeeToReady } from "@/lib/supabase/hr-pending-employees";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/hr/pending-employees/[id]/unpromote
 *
 * Sends a `promoted` staged hire back to `ready` (clears promoted_at +
 * promoted_to_master_id) so HR can re-promote. Also removes them from the master
 * list — the global_master_list row AND the master Google Sheet row — so they
 * drop out of active rosters until re-promoted (re-promote re-adds them).
 */
export async function POST(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireFeatureEdit('hr', 'onboarding');
  if (!authz.ok) return deniedResponse(authz);

  const { id: rawId } = await context.params;
  const id = Number.parseInt(rawId, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const { row, error } = await revertHrPendingEmployeeToReady(id);
  if (error) {
    const status = /only a promoted/i.test(error) ? 400 : 500;
    return NextResponse.json({ error }, { status });
  }
  return NextResponse.json({ row });
}
