import { NextResponse } from "next/server";
import {
  cancelHrPendingEmployee,
  deleteHrPendingEmployee,
  updateHrPendingEmployee,
  type UpdateHrPendingInput,
} from "@/lib/supabase/hr-pending-employees";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";
import { splitFullName } from "@/lib/hr/work-email";
import { createWorkspaceAccount } from "@/lib/hr/workspace-account";

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

/** DELETE — soft cancel by default; ?hard=true permanently removes the row. */
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
  const { error } = hard
    ? await deleteHrPendingEmployee(id)
    : await cancelHrPendingEmployee(id);
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ ok: true });
}
