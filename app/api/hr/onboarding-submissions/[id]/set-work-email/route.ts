import { NextResponse } from "next/server";
import {
  deniedResponse,
  requireElevatedSession,
} from "@/lib/auth/authorize-email";
import {
  getHrOnboardingSubmissionById,
  linkOnboardingToPendingHire,
} from "@/lib/supabase/hr-onboarding-submissions";
import { createHrPendingEmployee } from "@/lib/supabase/hr-pending-employees";
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
  if (row.pending_employee_id != null) {
    return NextResponse.json(
      {
        error: "This submission has already been converted to a pending hire.",
        pending_employee_id: row.pending_employee_id,
        work_email: row.work_email,
      },
      { status: 409 },
    );
  }

  const workEmail = (body.work_email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(workEmail)) {
    return NextResponse.json(
      { error: "Enter a valid work email." },
      { status: 400 },
    );
  }
  if (!workEmail.endsWith(`@${WORK_EMAIL_DOMAIN}`)) {
    return NextResponse.json(
      { error: `Work email must be on @${WORK_EMAIL_DOMAIN}.` },
      { status: 400 },
    );
  }

  const name = (row.full_name ?? row.invite_name ?? "").trim();
  const personalEmail = (row.email ?? row.invite_personal_email ?? "")
    .trim()
    .toLowerCase();
  const department = (body.department ?? row.invite_department ?? "").trim();

  if (!name) {
    return NextResponse.json(
      { error: "This submission has no name to create a hire from." },
      { status: 400 },
    );
  }
  if (!personalEmail) {
    return NextResponse.json(
      { error: "This submission has no personal email." },
      { status: 400 },
    );
  }
  if (!department) {
    return NextResponse.json(
      { error: "A department is required to stage this hire." },
      { status: 400 },
    );
  }

  // Race-safe re-check against the live roster right before we mint.
  let taken: Set<string>;
  try {
    taken = await loadTakenWorkEmails();
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to read roster" },
      { status: 500 },
    );
  }
  if (taken.has(workEmail)) {
    return NextResponse.json(
      { error: `${workEmail} is already in use. Pick another address.` },
      { status: 409 },
    );
  }

  // Normalize the rates HR entered. Stored on the staged hire and seeded into
  // employee_hourly_rates on promote; the regular rate doubles as the Hubstaff
  // pay_rate when no separate value is supplied.
  const toRateStr = (v: string | number | null | undefined): string | null => {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? String(n) : null;
  };
  const regularRateStr = toRateStr(body.regular_rate);
  const otRateStr = toRateStr(body.ot_rate);

  const { row: pending, error: createErr } = await createHrPendingEmployee({
    name,
    personal_email: personalEmail,
    work_email: workEmail,
    department,
    phone: row.phone,
    regular_rate: regularRateStr,
    ot_rate: otRateStr,
    source: "onboarding_form",
    created_by: authz.sessionEmail,
    onboarding_submission_id: row.id,
  });
  if (createErr || !pending) {
    return NextResponse.json(
      { error: createErr ?? "Failed to create pending hire" },
      { status: 500 },
    );
  }

  const { error: linkErr } = await linkOnboardingToPendingHire(row.id, {
    work_email: workEmail,
    pending_employee_id: pending.id,
  });
  if (linkErr) {
    // The hire exists in Pending Hires; we just couldn't stamp the submission.
    return NextResponse.json(
      {
        error: `Pending hire created, but linking the submission failed: ${linkErr}`,
        pending_employee_id: pending.id,
        work_email: workEmail,
      },
      { status: 500 },
    );
  }

  // Best-effort: provision the workspace account via the n8n webhook. A failure
  // here does NOT roll back the staged hire (per product decision) — we report
  // it so HR can retry or create the account manually.
  const { first, last } = splitFullName(name);
  const workspace = await createWorkspaceAccount({
    firstName: first,
    lastName: last,
    workEmail,
    personalEmail,
  });

  // Projects (if HR picked any) are recorded for reference; the current
  // workspace webhook does not consume them.
  const projectNames = Array.isArray(body.project_names)
    ? body.project_names.map((p) => String(p).trim()).filter(Boolean)
    : [];

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
