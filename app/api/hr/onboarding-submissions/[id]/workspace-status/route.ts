import { NextResponse } from "next/server";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";
import {
  getHrOnboardingSubmissionById,
  setOnboardingWorkspaceOutcome,
} from "@/lib/supabase/hr-onboarding-submissions";
import { insertAuditLog } from "@/lib/supabase/audit-log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/hr/onboarding-submissions/[id]/workspace-status
 *
 * Manual override of the workspace-account status. Used when HR has checked the
 * Google Admin console themselves and knows the truth that the create webhook
 * got wrong — e.g. a "create failed" that actually means the account already
 * exists. This does NOT call any webhook; it just stamps the stored status so
 * the Designated Work Email column reflects reality.
 *
 * Body: { ok: boolean }  // true = confirmed/designated, false = not provisioned
 */
export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireFeatureEdit('hr', 'onboarding');
  if (!authz.ok) return deniedResponse(authz);

  const { id } = await context.params;

  let body: { ok?: boolean };
  try {
    body = (await req.json()) as { ok?: boolean };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.ok !== "boolean") {
    return NextResponse.json(
      { error: "Body must include a boolean `ok`." },
      { status: 400 },
    );
  }

  const { row, error: fetchErr } = await getHrOnboardingSubmissionById(id);
  if (fetchErr) return NextResponse.json({ error: fetchErr }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const workEmail = row.work_email?.trim().toLowerCase() ?? "";
  if (!workEmail) {
    return NextResponse.json(
      { error: "This submission has no work email." },
      { status: 400 },
    );
  }

  const { error: upErr } = await setOnboardingWorkspaceOutcome(id, {
    ok: body.ok,
    status: null,
    error: body.ok ? null : "Marked as not provisioned by HR.",
  });
  if (upErr) return NextResponse.json({ error: upErr }, { status: 500 });

  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: "HR",
    action: "hr.onboarding.set_workspace_status",
    resource: "hr_onboarding_submissions",
    resource_id: row.id,
    details: { work_email: workEmail, ok: body.ok, manual: true },
  });

  return NextResponse.json({ ok: true, workspace_account_ok: body.ok });
}
