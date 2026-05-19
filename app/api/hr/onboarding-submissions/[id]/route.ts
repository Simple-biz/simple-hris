import { NextResponse } from "next/server";
import {
  archiveHrOnboardingSubmission,
  deleteHrOnboardingSubmission,
  getHrOnboardingSubmissionById,
  getW8BenSignedUrl,
} from "@/lib/supabase/hr-onboarding-submissions";
import {
  deniedResponse,
  requireElevatedSession,
} from "@/lib/auth/authorize-email";

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
  return NextResponse.json({ row, w8benUrl });
}

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);
  const { id } = await context.params;
  const hard = new URL(req.url).searchParams.get("hard") === "true";
  const { error } = hard
    ? await deleteHrOnboardingSubmission(id)
    : await archiveHrOnboardingSubmission(id);
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ ok: true });
}
