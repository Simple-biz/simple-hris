import { NextResponse } from "next/server";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";
import { getHrPendingEmployeeById } from "@/lib/supabase/hr-pending-employees";
import { createWorkspaceAccount } from "@/lib/hr/workspace-account";
import { splitFullName } from "@/lib/hr/work-email";
import { insertAuditLog } from "@/lib/supabase/audit-log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/hr/pending-employees/[id]/retry-workspace
 *
 * Re-fires the combined onboarding webhook (Google Workspace account,
 * Hubstaff invite, Roboform + Hubstaff overview emails) for a hire that
 * already has a work email. Used when the initial workspace setup failed
 * or was skipped. Idempotent from the webhook's perspective — re-inviting
 * an existing user is safe.
 *
 * Requires status to be 'ready' or 'promoted' (work_email must be set).
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

  const { row, error: fetchErr } = await getHrPendingEmployeeById(id);
  if (fetchErr) return NextResponse.json({ error: fetchErr }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const workEmail = row.work_email?.trim().toLowerCase() ?? "";
  if (!workEmail) {
    return NextResponse.json(
      { error: "This hire has no work email set yet — assign one before retrying workspace setup." },
      { status: 400 },
    );
  }

  if (row.status === "cancelled" || row.status === "no_show" || row.status === "pending_work_email") {
    return NextResponse.json(
      { error: `Cannot retry workspace setup for a ${row.status.replace("_", " ")} hire.` },
      { status: 400 },
    );
  }

  const { first, last } = splitFullName(row.name);
  const payRate =
    row.regular_rate != null && Number.isFinite(Number(row.regular_rate))
      ? Number(row.regular_rate)
      : 0;
  const projectNames = Array.isArray(row.project_names) ? row.project_names : [];

  const workspace = await createWorkspaceAccount({
    firstName: first,
    lastName: last,
    workEmail,
    personalEmail: row.personal_email,
    projectNames,
    payRate,
  });

  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: "HR",
    action: "hr.pending.retry_workspace",
    resource: "hr_pending_employees",
    resource_id: String(row.id),
    details: {
      work_email: workEmail,
      workspace_ok: workspace.ok,
      workspace_error: workspace.ok ? null : (workspace.error ?? null),
    },
  });

  if (!workspace.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: workspace.error ?? "Workspace webhook failed. Check the n8n logs and retry manually.",
        workspace,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, workspace });
}
