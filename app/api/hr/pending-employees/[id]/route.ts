import { NextResponse } from "next/server";
import {
  cancelHrPendingEmployee,
  deleteHrPendingEmployee,
  getHrPendingEmployeeById,
  updateHrPendingEmployee,
  type UpdateHrPendingInput,
} from "@/lib/supabase/hr-pending-employees";
import { archiveHrOnboardingSubmission } from "@/lib/supabase/hr-onboarding-submissions";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";
import { splitFullName } from "@/lib/hr/work-email";
import { createWorkspaceAccount } from "@/lib/hr/workspace-account";
import {
  OFFBOARD_DELETE_SLUG,
  fireOffboardWebhook,
  type OffboardWebhookResult,
} from "@/lib/hr/offboard-webhooks";
import { insertAuditLog } from "@/lib/supabase/audit-log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function parseId(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * PATCH — partial update to a staged hire (e.g. setting work_email later).
 *
 * When a work_email is being set for the first time on a directly-added hire
 * (not via the onboarding-form set-work-email route), this fires the combined
 * onboarding webhook so the Workspace account, Hubstaff invite, and
 * instructional emails all go out at the same moment.
 */
export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const { id: rawId } = await context.params;
  const id = parseId(rawId);
  if (id === null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  let body: UpdateHrPendingInput;
  try {
    body = (await req.json()) as UpdateHrPendingInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { row, error } = await updateHrPendingEmployee(id, body);
  if (error) return NextResponse.json({ error }, { status: 500 });

  // Fire the combined onboarding webhook when work_email is being set on a
  // directly-added hire. Best-effort — a webhook failure never blocks the
  // update. The set-work-email onboarding-form route handles its own webhook
  // call, so this only fires for hires added manually via "Add person".
  let workspace: { ok: boolean; status?: number; error?: string } | null = null;
  const workEmailInBody =
    typeof body.work_email === "string" && body.work_email.trim().length > 0;
  if (workEmailInBody && row) {
    const workEmail = row.work_email ?? "";
    const name = (row.name ?? "").trim();
    const personalEmail = (row.personal_email ?? "").trim();
    const projectNames = Array.isArray(row.project_names)
      ? row.project_names.map((p) => String(p).trim()).filter(Boolean)
      : [];

    if (workEmail && name && personalEmail) {
      const { first, last } = splitFullName(name);
      const payRate =
        row.regular_rate != null && Number.isFinite(Number(row.regular_rate))
          ? Number(row.regular_rate)
          : 0;
      workspace = await createWorkspaceAccount({
        firstName: first,
        lastName: last,
        workEmail,
        personalEmail,
        projectNames,
        payRate,
      });
      if (!workspace.ok) {
        console.warn(
          `[PATCH pending-employee] workspace webhook skipped for ${workEmail}: ${workspace.error ?? "unknown"}`,
        );
      }
    }
  }

  return NextResponse.json({ row, workspace });
}

/**
 * DELETE — soft cancel by default; ?hard=true permanently removes the row.
 *
 * Soft cancel (the "X" action in Pending Hires) is a full teardown:
 *   1. Deletes the @simple.biz Workspace account + Hubstaff member immediately
 *      via the `offboarding_delete` webhook (only when a work email exists, i.e.
 *      an account was ever provisioned). never_promoted tells n8n the Hubstaff
 *      invite only went out if/when the hire was promoted.
 *   2. Archives the linked onboarding submission so it leaves the active
 *      Onboarding Form views (kept under the Archived filter for audit).
 *   3. Flips the row to 'cancelled' so it shows in the Cancelled tab.
 * Promoted hires are rejected — they're real master-list employees and must go
 * through the HR Offboard flow. Webhook + archive are best-effort: a failure is
 * surfaced to HR but never blocks the cancel.
 */
export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const { id: rawId } = await context.params;
  const id = parseId(rawId);
  if (id === null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const hard = new URL(req.url).searchParams.get("hard") === "true";

  // Hard delete = permanent DB removal (UI exposes this for Cancelled/No-show rows only).
  if (hard) {
    const { error } = await deleteHrPendingEmployee(id);
    if (error) return NextResponse.json({ error }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  // Soft cancel + account teardown.
  const { row, error: fetchErr } = await getHrPendingEmployeeById(id);
  if (fetchErr) return NextResponse.json({ error: fetchErr }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Pending hire not found" }, { status: 404 });
  if (row.status === "promoted") {
    return NextResponse.json(
      {
        error:
          "This hire was already promoted. Use the HR Offboard flow instead of cancel.",
      },
      { status: 400 },
    );
  }

  const workEmail = (row.work_email ?? "").trim().toLowerCase();
  const nowIso = new Date().toISOString();

  // 1. Delete the Workspace account + Hubstaff member now (only if provisioned).
  let webhook: OffboardWebhookResult | null = null;
  if (workEmail) {
    webhook = await fireOffboardWebhook(OFFBOARD_DELETE_SLUG, {
      event: "hire.cancelled",
      phase: "delete",
      deletion_mode: "immediate",
      never_promoted: true,
      hubstaff_pay_rate: 0,
      work_email: workEmail,
      personal_email: row.personal_email,
      name: row.name,
      departments: row.department ? [row.department] : [],
      cancelled_by: authz.sessionEmail,
      cancelled_at: nowIso,
    });
  }

  // 2. Archive the linked onboarding submission (best-effort).
  let onboardingArchived = false;
  if (row.onboarding_submission_id) {
    const { error: archiveErr } = await archiveHrOnboardingSubmission(
      row.onboarding_submission_id,
    );
    if (archiveErr) {
      console.warn(
        `[cancel pending-employee] onboarding archive skipped for submission ${row.onboarding_submission_id}: ${archiveErr}`,
      );
    } else {
      onboardingArchived = true;
    }
  }

  // 3. Flip the row to 'cancelled'. Stamp deletion_processed_at when a teardown
  //    was fired so it's recorded as handled and the cron never re-picks it.
  const { error: cancelErr } = await cancelHrPendingEmployee(id, {
    deletionProcessedAt: workEmail ? nowIso : null,
  });
  if (cancelErr) return NextResponse.json({ error: cancelErr }, { status: 500 });

  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: authz.roles[0] ?? "admin",
    action: "hr.hire.cancelled",
    resource: "hr_pending_employees",
    resource_id: String(id),
    details: {
      target_email: workEmail || null,
      department: row.department,
      had_account: !!workEmail,
      onboarding_submission_id: row.onboarding_submission_id,
      onboarding_archived: onboardingArchived,
      webhook_fired: webhook ? webhook.fired && webhook.error == null : false,
      webhook_status: webhook?.status ?? null,
      webhook_error: webhook?.error ?? null,
    },
  });

  return NextResponse.json({
    ok: true,
    webhook,
    onboarding_archived: onboardingArchived,
  });
}
