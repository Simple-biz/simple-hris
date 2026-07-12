import { NextResponse } from "next/server";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";
import { verifyWorkspaceAccount } from "@/lib/hr/workspace-account";
import { WORK_EMAIL_DOMAIN } from "@/lib/hr/work-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/hr/workspace-account/verify
 *
 * Read-only lookup of whether a given @simple.biz Google Workspace account
 * exists, via the n8n `verify_workspace_account` webhook. NEVER creates
 * anything. Unlike /onboarding-submissions/[id]/verify-work-email this is NOT
 * tied to a submission — it just answers "does this address exist?".
 *
 * Used by the onboarding "Bypass" flow so HR can confirm a worker's account is
 * already provisioned BEFORE staging + promoting them straight to the master
 * list (the bypass endpoint re-checks server-side; this powers the modal's
 * Verify button and green-check gate).
 *
 * Body: { work_email: string }
 * Returns: { ok, state: 'exists'|'missing'|'error', http_status, detail }
 */
export async function POST(req: Request) {
  const authz = await requireFeatureEdit("hr", "onboarding");
  if (!authz.ok) return deniedResponse(authz);

  let body: { work_email?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

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

  const result = await verifyWorkspaceAccount(workEmail);
  return NextResponse.json({
    ok: result.state === "exists",
    state: result.state,
    work_email: workEmail,
    http_status: result.httpStatus ?? null,
    detail: result.error ?? null,
  });
}
