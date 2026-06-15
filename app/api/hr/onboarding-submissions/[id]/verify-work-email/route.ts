import { NextResponse } from "next/server";
import {
  deniedResponse,
  requireElevatedSession,
} from "@/lib/auth/authorize-email";
import {
  getHrOnboardingSubmissionById,
  setOnboardingWorkspaceOutcome,
} from "@/lib/supabase/hr-onboarding-submissions";
import { verifyWorkspaceAccount } from "@/lib/hr/workspace-account";
import { insertAuditLog } from "@/lib/supabase/audit-log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/hr/onboarding-submissions/[id]/verify-work-email
 *
 * Read-only check of whether the hire's @simple.biz Google Workspace account
 * actually exists, via the n8n `verify_workspace_account` webhook. This NEVER
 * creates anything, so it's the safe way to resolve an "Unverified" row (or
 * re-confirm a failed one) without risking a duplicate account.
 *
 *   - account found    -> stamp workspace_account_ok = true  (confirmed)
 *   - account missing  -> stamp workspace_account_ok = false (needs provisioning)
 *   - could not check  -> leave the stored status untouched; report the reason
 */
export async function POST(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const { id } = await context.params;

  const { row, error: fetchErr } = await getHrOnboardingSubmissionById(id);
  if (fetchErr) return NextResponse.json({ error: fetchErr }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const workEmail = row.work_email?.trim().toLowerCase() ?? "";
  if (!workEmail) {
    return NextResponse.json(
      { error: "This submission has no work email to verify." },
      { status: 400 },
    );
  }

  const result = await verifyWorkspaceAccount(workEmail);

  // Could not determine — don't clobber whatever we already know. Surface why.
  if (result.state === "error") {
    void insertAuditLog({
      user_name: authz.sessionEmail,
      user_role: "HR",
      action: "hr.onboarding.verify_work_email",
      resource: "hr_onboarding_submissions",
      resource_id: row.id,
      details: { work_email: workEmail, outcome: "error", error: result.error ?? null },
    });
    return NextResponse.json({
      ok: false,
      state: "error",
      work_email: workEmail,
      http_status: result.httpStatus ?? null,
      detail: result.error ?? null,
      error: result.error ?? "Could not verify the account.",
    });
  }

  const exists = result.state === "exists";
  const { error: upErr } = await setOnboardingWorkspaceOutcome(id, {
    ok: exists,
    status: result.httpStatus ?? null,
    error: exists ? null : "Account not found in Google Workspace.",
  });
  if (upErr) return NextResponse.json({ error: upErr }, { status: 500 });

  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: "HR",
    action: "hr.onboarding.verify_work_email",
    resource: "hr_onboarding_submissions",
    resource_id: row.id,
    details: { work_email: workEmail, outcome: result.state },
  });

  return NextResponse.json({
    ok: true,
    state: result.state,
    work_email: workEmail,
    workspace_account_ok: exists,
    http_status: result.httpStatus ?? null,
    detail: result.error ?? null,
  });
}
