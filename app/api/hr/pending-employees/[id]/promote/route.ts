import { NextResponse } from "next/server";
import {
  promoteHrPendingEmployee,
  redactPendingRowRates,
} from "@/lib/supabase/hr-pending-employees";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { hasRateVisibility } from "@/lib/auth/elevated-roles";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";
import { insertAuditLog } from "@/lib/supabase/audit-log";

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
  const authz = await requireFeatureEdit('hr', 'onboarding');
  if (!authz.ok) return deniedResponse(authz);

  const { id: rawId } = await context.params;
  const id = Number.parseInt(rawId, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const { row, masterId, error, sheet } = await promoteHrPendingEmployee(id);
  // Never echo the staged hire's pay rate back to the HR client.
  const safeRow = redactPendingRowRates(row, hasRateVisibility(authz.roles));
  if (error) {
    // Distinguish validation errors (missing work_email, already promoted) from server errors.
    const status =
      /work email|already promoted|cancelled|no current master|no_show/i.test(error)
        ? 400
        : 500;
    return NextResponse.json({ row: safeRow, masterId, error }, { status });
  }

  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: authz.roles[0] ?? "hr",
    action: "hr.pending.promoted",
    resource: "hr_pending_employees",
    resource_id: String(id),
    details: {
      name: row?.name ?? null,
      work_email: row?.work_email ?? null,
      department: row?.department ?? null,
      master_id: masterId ?? null,
    },
  });

  return NextResponse.json({ row: safeRow, masterId, sheet });
}
