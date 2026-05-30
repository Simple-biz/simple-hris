import { NextResponse } from "next/server";
import {
  deniedResponse,
  requireElevatedSession,
} from "@/lib/auth/authorize-email";
import {
  getHrOnboardingSubmissionById,
  linkOnboardingToPendingHire,
} from "@/lib/supabase/hr-onboarding-submissions";
import {
  createHrPendingEmployee,
  updateHrPendingEmployee,
} from "@/lib/supabase/hr-pending-employees";
import { loadTakenWorkEmails } from "@/lib/hr/work-email-server";
import { WORK_EMAIL_DOMAIN, splitFullName } from "@/lib/hr/work-email";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { createWorkspaceAccount } from "@/lib/hr/workspace-account";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/hr/onboarding-submissions/[id]/set-work-email
 *
 * Mints the work email on a SUBMITTED onboarding form and spins up a matching
 * `hr_pending_employees` row (status -> ready), so the hire joins the existing
 * Promote -> global_master_list pipeline. The submission is stamped with the
 * address + the staged-hire id. Idempotent guard: a submission already linked
 * to a pending hire is rejected.
 *
 * Body: { work_email: string; department?: string }
 *   - work_email must be on the company domain (@simple.biz).
 *   - department falls back to the submission's invite_department; required
 *     because hr_pending_employees.department is NOT NULL.
 */
export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const { id } = await context.params;

  let body: {
    work_email?: string;
    department?: string;
    project_names?: string[];
    regular_rate?: string | number | null;
    ot_rate?: string | number | null;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { row, error: fetchErr } = await getHrOnboardingSubmissionById(id);
  if (fetchErr) return NextResponse.json({ error: fetchErr }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (row.status !== "submitted") {
    return NextResponse.json(
      {
        error:
          row.status === "pending"
            ? "This form has not been submitted yet."
            : "This submission is archived.",
      },
      { status: 400 },
    );
  }
  const isUpdate = row.pending_employee_id != null;

  const workEmail = (body.work_email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(workEmail)) {
    return NextResponse.json({ error: "Enter a valid work email." }, { status: 400 });
  }
  if (!workEmail.endsWith(`@${WORK_EMAIL_DOMAIN}`)) {
    return NextResponse.json(
      { error: `Work email must be on @${WORK_EMAIL_DOMAIN}.` },
      { status: 400 },
    );
  }

  const name = (row.full_name ?? row.invite_name ?? "").trim();
  const personalEmail = (row.email ?? row.invite_personal_email ?? "").trim().toLowerCase();
  const department = (body.department ?? row.invite_department ?? "").trim();

  if (!name) {
    return NextResponse.json(
      { error: "This submission has no name to create a hire from." },
      { status: 400 },
    );
  }
  if (!personalEmail) {
    return NextResponse.json({ error: "This submission has no personal email." }, { status: 400 });
  }
  if (!department) {
    return NextResponse.json(
      { error: "A department is required to stage this hire." },
      { status: 400 },
    );
  }

  // Race-safe availability check. Allow the hire's current work_email to pass
  // through unchanged (re-setting the same address is fine).
  const currentWorkEmail = row.work_email?.trim().toLowerCase() ?? "";
  let taken: Set<string>;
  try {
    taken = await loadTakenWorkEmails();
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to read roster" },
      { status: 500 },
    );
  }
  if (taken.has(workEmail) && workEmail !== currentWorkEmail) {
    return NextResponse.json(
      { error: `${workEmail} is already in use. Pick another address.` },
      { status: 409 },
    );
  }

  const toRateStr = (v: string | number | null | undefined): string | null => {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? String(n) : null;
  };
  const regularRateStr = toRateStr(body.regular_rate);
  const otRateStr = toRateStr(body.ot_rate);

  const projectNames = Array.isArray(body.project_names)
    ? body.project_names.map((p) => String(p).trim()).filter(Boolean)
    : [];

  let pending: Awaited<ReturnType<typeof createHrPendingEmployee>>["row"];

  if (isUpdate && row.pending_employee_id) {
    // Re-submission: update the existing pending hire with the latest details
    // so payroll rates, project assignments, and the work email stay in sync.
    const { row: updated, error: updateErr } = await updateHrPendingEmployee(
      row.pending_employee_id,
      {
        name,
        work_email: workEmail,
        department,
        regular_rate: regularRateStr ?? undefined,
        ot_rate: otRateStr ?? undefined,
        project_names: projectNames,
      },
    );
    if (updateErr || !updated) {
      return NextResponse.json(
        { error: updateErr ?? "Failed to update pending hire" },
        { status: 500 },
      );
    }
    pending = updated;
  } else {
    // First time: create a fresh pending hire from the submission.
    const { row: created, error: createErr } = await createHrPendingEmployee({
      name,
      personal_email: personalEmail,
      work_email: workEmail,
      department,
      phone: row.phone,
      regular_rate: regularRateStr,
      ot_rate: otRateStr,
      project_names: projectNames,
      source: "onboarding_form",
      created_by: authz.sessionEmail,
      onboarding_submission_id: row.id,
    });
    if (createErr || !created) {
      return NextResponse.json(
        { error: createErr ?? "Failed to create pending hire" },
        { status: 500 },
      );
    }
    pending = created;
  }

  // (Re-)link the submission so it always reflects the latest work_email.
  const { error: linkErr } = await linkOnboardingToPendingHire(row.id, {
    work_email: workEmail,
    pending_employee_id: pending!.id,
  });
  if (linkErr) {
    return NextResponse.json(
      {
        error: `Pending hire ${isUpdate ? "updated" : "created"}, but linking the submission failed: ${linkErr}`,
        pending_employee_id: pending!.id,
        work_email: workEmail,
      },
      { status: 500 },
    );
  }

  // Best-effort: fire the combined onboarding webhook — creates the Workspace
  // account, invites to Hubstaff, sends the Roboform + Hubstaff overview emails.
  // A failure here does NOT roll back the staged hire — report it so HR can
  // retry or handle manually. pay_rate defaults to 0 (prevents the "USD" bug
  // in Hubstaff; the real rate is stored on the pending row for payroll).
  const { first, last } = splitFullName(name);
  const payRate =
    regularRateStr != null && Number.isFinite(Number(regularRateStr))
      ? Number(regularRateStr)
      : 0;
  const workspace = await createWorkspaceAccount({
    firstName: first,
    lastName: last,
    workEmail,
    personalEmail,
    projectNames,
    payRate,
  });

  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: "HR",
    action: "hr.onboarding.set_work_email",
    resource: "hr_onboarding_submissions",
    resource_id: row.id,
    details: {
      work_email: workEmail,
      pending_employee_id: pending.id,
      department,
      name,
      project_names: projectNames,
      regular_rate: regularRateStr,
      ot_rate: otRateStr,
      workspace_account_ok: workspace.ok,
      workspace_account_error: workspace.ok ? null : workspace.error ?? null,
    },
  });

  return NextResponse.json({
    ok: true,
    pending_employee_id: pending.id,
    work_email: workEmail,
    status: pending.status,
    workspace_account: workspace,
  });
}
