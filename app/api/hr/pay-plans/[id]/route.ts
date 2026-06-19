import { NextResponse } from "next/server";
import { deleteOnboardingPayPlan } from "@/lib/supabase/onboarding-pay-plans";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * DELETE /api/hr/pay-plans/[id]
 * Removes a pay plan (storage object + row). Auth: HR onboarding edit.
 */
export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireFeatureEdit("hr", "onboarding");
  if (!authz.ok) return deniedResponse(authz);

  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const { error } = await deleteOnboardingPayPlan(id);
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ ok: true });
}
