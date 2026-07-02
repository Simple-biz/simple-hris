import { NextResponse } from "next/server";
import {
  archiveHrOnboardingSubmission,
  deleteHrOnboardingSubmission,
  getHrOnboardingSubmissionById,
  getIpAssignmentSignedUrl,
  getW8BenSignedUrl,
} from "@/lib/supabase/hr-onboarding-submissions";
import {
  deniedResponse,
  requireElevatedSession,
} from "@/lib/auth/authorize-email";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";
import { insertAuditLog } from "@/lib/supabase/audit-log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);
  const { id } = await context.params;
  const { row, error } = await getHrOnboardingSubmissionById(id);
  if (error) return NextResponse.json({ error }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // If the submission has a W-8BEN file, sign a short-lived URL HR can use.
  let w8benUrl: string | null = null;
  if (row.w8ben_file_path) {
    const signed = await getW8BenSignedUrl(row.w8ben_file_path, 600);
    w8benUrl = signed.url;
  }
  // Likewise for the generated Intellectual Property Assignment PDF.
  let ipAssignmentUrl: string | null = null;
  if (row.ip_assignment_file_path) {
    const signed = await getIpAssignmentSignedUrl(row.ip_assignment_file_path, 600);
    ipAssignmentUrl = signed.url;
  }
  return NextResponse.json({ row, w8benUrl, ipAssignmentUrl });
}

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireFeatureEdit('hr', 'onboarding');
  if (!authz.ok) return deniedResponse(authz);
  const { id } = await context.params;
  const hard = new URL(req.url).searchParams.get("hard") === "true";
  // Capture identity for the audit trail before the row is archived/removed.
  const { row: existing } = await getHrOnboardingSubmissionById(id);
  const { error } = hard
    ? await deleteHrOnboardingSubmission(id)
    : await archiveHrOnboardingSubmission(id);
  if (error) return NextResponse.json({ error }, { status: 500 });

  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: authz.roles[0] ?? "hr",
    action: hard ? "hr.onboarding.deleted" : "hr.onboarding.archived",
    resource: "hr_onboarding_submissions",
    resource_id: id,
    details: {
      name: existing?.full_name ?? existing?.invite_name ?? null,
      personal_email: existing?.email ?? existing?.invite_personal_email ?? null,
      hard,
    },
  });

  return NextResponse.json({ ok: true });
}
