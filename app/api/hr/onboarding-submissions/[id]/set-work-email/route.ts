import { NextResponse } from "next/server";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";
import {
  getHrOnboardingSubmissionById,
  linkOnboardingToPendingHire,
} from "@/lib/supabase/hr-onboarding-submissions";
import {
  createHrPendingEmployee,
  updateHrPendingEmployee,
} from "@/lib/supabase/hr-pending-employees";
import { loadTakenWorkEmails } from "@/lib/hr/work-email-server";
import { WORK_EMAIL_DOMAIN, splitFullName, gmailSurnameFromWorkEmail } from "@/lib/hr/work-email";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { createWorkspaceAccount, verifyWorkspaceAccount } from "@/lib/hr/workspace-account";
import { listPayStructures } from "@/lib/supabase/pay-structures-db";
import { DEPARTMENTS } from "@/lib/payroll/department-bonus";
import {
  consumeAvailableLicenses,
  isLicenseAutoCountConfigured,
} from "@/lib/google-workspace/licenses";

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
  const authz = await requireFeatureEdit('hr', 'onboarding');
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
    // The roster says it's taken — but a prior failed attempt can leave an
    // address claimed with no real Google Workspace account behind it. Ask the
    // verify webhook: only block when an account actually exists (or we can't
    // tell). A definite "missing" means the claim is stale, so allow reclaiming.
    const v = await verifyWorkspaceAccount(workEmail);
    if (v.state !== "missing") {
      return NextResponse.json(
        { error: `${workEmail} is already in use. Pick another address.` },
        { status: 409 },
      );
    }
  }

  const toRateStr = (v: string | number | null | undefined): string | null => {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? String(n) : null;
  };

  // Resolve the AUTHORITATIVE compensation from Accounting's Payment Catalog
  // (department-scoped pay structure). HR never sets/sees the figures, so the
  // catalog is the source of truth — we look it up server-side and prefer it
  // over anything the client sent. These flow to the pending hire's payroll
  // rates AND to the webhook so Hubstaff gets a real Reg/OT rate (it rejects 0).
  let catalogRegular: string | null = null;
  let catalogOt: string | null = null;
  try {
    const deptLc = department.toLowerCase();
    const deptKey = DEPARTMENTS.find((d) => d.name.trim().toLowerCase() === deptLc)?.key ?? null;
    const { structures } = await listPayStructures();
    const match = structures.find((s) => {
      if (s.scope !== "department") return false;
      if (deptKey && s.departmentKey === deptKey) return true;
      const name = DEPARTMENTS.find((d) => d.key === s.departmentKey)?.name ?? s.departmentKey;
      return name.trim().toLowerCase() === deptLc;
    });
    if (match) {
      catalogRegular = String(match.regularRate);
      catalogOt = match.otRate != null ? String(match.otRate) : null;
    }
  } catch {
    // Catalog unreachable — fall back to whatever the client sent (legacy).
  }

  const regularRateStr = toRateStr(catalogRegular ?? body.regular_rate);
  const otRateStr = toRateStr(catalogOt ?? body.ot_rate);

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
      location: row.location,
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

  // Best-effort: fire the combined onboarding webhook — creates the Workspace
  // account, invites to Hubstaff, sends the Roboform + Hubstaff overview emails.
  // A failure here does NOT roll back the staged hire — report it so HR can
  // retry or handle manually. pay_rate defaults to 0 (prevents the "USD" bug
  // in Hubstaff; the real rate is stored on the pending row for payroll).
  //
  // The webhook fires BEFORE the link write so its outcome can be persisted in
  // the same UPDATE. That's what lets the Submitted tab tell a CONFIRMED
  // designated work email (200) apart from a minted-but-failed one. A retry
  // that finally succeeds re-runs this and flips the row to confirmed.
  const { first, last } = splitFullName(name);
  // Surname sent to the workspace webhook IN PLACE OF the legal last name, on
  // purpose: the Workspace account must never expose the hire's full surname (so
  // they can't be looked up / stalked elsewhere). We derive it from the chosen
  // work email's slice (e.g. kanere@ -> "RE") so the account surname always
  // matches its address; this mirrors the read-only "Gmail Surname" the hire saw
  // on the paperwork. Falls back to the last-name INITIAL — never the full name.
  const gmailSurname = gmailSurnameFromWorkEmail(first, workEmail, last);
  const payRate =
    regularRateStr != null && Number.isFinite(Number(regularRateStr))
      ? Number(regularRateStr)
      : 0;
  const otPayRate =
    otRateStr != null && Number.isFinite(Number(otRateStr)) ? Number(otRateStr) : null;
  const workspace = await createWorkspaceAccount({
    firstName: first,
    lastName: gmailSurname,
    workEmail,
    personalEmail,
    projectNames,
    payRate,
    otRate: otPayRate,
  });

  // Resolve the outcome we'll persist. A create that reports failure does NOT
  // necessarily mean there's no account: a retry after a transient/license
  // failure, or an account the pending-license queue provisioned out of band,
  // already EXISTS — and the create API can't create a duplicate, so it errors
  // and the row would wrongly stay "Account Creation Failed" forever. So when
  // create fails, ask the read-only verify webhook whether the account actually
  // exists; if it does, treat this as a CONFIRMED designated work email.
  let workspaceOk = workspace.ok;
  let workspaceStatus = workspace.status;
  let workspaceError: string | undefined = workspace.error;
  if (!workspace.ok) {
    const verified = await verifyWorkspaceAccount(workEmail);
    if (verified.state === "exists") {
      workspaceOk = true;
      workspaceStatus = verified.httpStatus ?? workspace.status;
      workspaceError = undefined;
    }
  }

  // (Re-)link the submission so it always reflects the latest work_email, and
  // stamp the (verify-resolved) webhook outcome alongside it.
  const { error: linkErr } = await linkOnboardingToPendingHire(row.id, {
    work_email: workEmail,
    pending_employee_id: pending!.id,
    workspace: { ok: workspaceOk, status: workspaceStatus, error: workspaceError },
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

  // A newly-provisioned account consumes a Workspace license. Decrement the
  // cached available count ONLY when this row transitions into confirmed (it
  // wasn't already confirmed before) — so a retry/re-set on an already-confirmed
  // row never double-counts. Skipped in live mode: there the GET recomputes
  // available = total - assigned from the Google API, which already reflects the
  // new assignment, so a manual decrement would be redundant (and invisible).
  const newlyConsumedLicense = workspaceOk && row.workspace_account_ok !== true;
  let availableLicenses: number | null = null;
  if (newlyConsumedLicense && !isLicenseAutoCountConfigured()) {
    try {
      const res = await consumeAvailableLicenses(1);
      availableLicenses = res?.available ?? null;
    } catch {
      // Best-effort — never block the set on the license bookkeeping.
    }
  }

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
      gmail_surname: gmailSurname,
      project_names: projectNames,
      regular_rate: regularRateStr,
      ot_rate: otRateStr,
      workspace_account_ok: workspaceOk,
      workspace_account_error: workspaceOk ? null : workspaceError ?? null,
      // Note when the account was confirmed via verify after a create failure.
      workspace_confirmed_via_verify: !workspace.ok && workspaceOk,
      license_consumed: newlyConsumedLicense,
    },
  });

  return NextResponse.json({
    ok: true,
    pending_employee_id: pending.id,
    work_email: workEmail,
    status: pending.status,
    available_licenses: availableLicenses,
    workspace_account: {
      ok: workspaceOk,
      status: workspaceStatus,
      error: workspaceError,
      confirmed_via_verify: !workspace.ok && workspaceOk,
    },
  });
}
