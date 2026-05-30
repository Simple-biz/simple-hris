import { NextResponse } from "next/server";
import { promoteHrPendingEmployee } from "@/lib/supabase/hr-pending-employees";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/hr/pending-employees/[id]/promote
 *
 * Copies the staged row into `global_master_list` (stamped with the current
 * upload id so it appears in `active_employees`) and flips the staging row to
 * status='promoted'. Refuses if the row is missing a work_email.
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

  const { row, masterId, error, sheet } = await promoteHrPendingEmployee(id);
  if (error) {
    // Distinguish validation errors (missing work_email, already promoted) from server errors.
    const status =
      /work email|already promoted|cancelled|no current master|no_show/i.test(error)
        ? 400
        : 500;
    return NextResponse.json({ row, masterId, error }, { status });
  }
  return NextResponse.json({ row, masterId, sheet });
}
