import { NextResponse } from "next/server";
import {
  createHrOnboardingLink,
  findActiveSubmissionByEmail,
  listHrOnboardingSubmissions,
  type CreateOnboardingLinkInput,
} from "@/lib/supabase/hr-onboarding-submissions";
import {
  deniedResponse,
  requireElevatedSession,
} from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);
  const { rows, error } = await listHrOnboardingSubmissions();
  if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
  return NextResponse.json({ rows });
}

export async function POST(req: Request) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  let body: Partial<CreateOnboardingLinkInput>;
  try {
    body = (await req.json()) as Partial<CreateOnboardingLinkInput>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const inviteEmail = body.invite_personal_email?.trim().toLowerCase() ?? "";
  if (inviteEmail) {
    const { row: existing, error: checkErr } = await findActiveSubmissionByEmail(inviteEmail);
    if (checkErr) return NextResponse.json({ error: checkErr }, { status: 500 });
    if (existing) {
      return NextResponse.json(
        {
          error: `An active onboarding link already exists for ${inviteEmail}. Archive it first before creating a new one.`,
          existing_id: existing.id,
        },
        { status: 409 },
      );
    }
  }

  const { row, error } = await createHrOnboardingLink({
    invite_name: body.invite_name,
    invite_personal_email: body.invite_personal_email,
    invite_department: body.invite_department,
    invite_note: body.invite_note,
    created_by: authz.sessionEmail,
  });
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ row });
}
