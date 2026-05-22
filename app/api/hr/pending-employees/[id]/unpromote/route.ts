import { NextResponse } from "next/server";
import { revertHrPendingEmployeeToReady } from "@/lib/supabase/hr-pending-employees";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/hr/pending-employees/[id]/unpromote
 *
 * Sends a `promoted` staged hire back to `ready` (clears promoted_at +
 * promoted_to_master_id) so HR can re-promote. The global_master_list row from
 * the original promote is left intact — re-promoting reuses it.
 */
export async function POST(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireElevatedSession();
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
