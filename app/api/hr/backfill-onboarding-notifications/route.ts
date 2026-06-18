import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/hr/backfill-onboarding-notifications
 *
 * Creates missing `onboarding.submitted` notifications for all `submitted`
 * onboarding forms that don't already have one. Idempotent — deduped via
 * the submission_id stored in the details JSONB so re-running is safe.
 * Gated to elevated (HR/admin) sessions.
 */
export async function POST() {
  const authz = await requireFeatureEdit('hr', 'onboarding');
  if (!authz.ok) return deniedResponse(authz);

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    return NextResponse.json({ created: 0, error: "DB unavailable" }, { status: 500 });
  }

  // 1. All submitted forms
  const { data: submissions, error: subErr } = await supabase
    .from("hr_onboarding_submissions")
    .select("id, full_name, invite_personal_email, email, invite_department, submitted_at")
    .eq("status", "submitted")
    .order("submitted_at", { ascending: false });

  if (subErr) {
    return NextResponse.json({ created: 0, error: subErr.message }, { status: 500 });
  }
  if (!submissions || submissions.length === 0) {
    return NextResponse.json({ created: 0 });
  }

  // 2. Already-notified submission IDs (avoid duplicates)
  const { data: existing } = await supabase
    .from("employee_notifications")
    .select("details")
    .eq("type", "onboarding.submitted");

  const alreadyNotified = new Set<string>(
    (existing ?? [])
      .map((r: { details?: { submission_id?: string } | null }) => r.details?.submission_id)
      .filter((id): id is string => !!id),
  );

  // 3. HR/admin recipient emails
  const { data: roleRows } = await supabase
    .from("employee_roles")
    .select("work_email")
    .in("role", ["hr_coordinator", "admin"])
    .is("revoked_at", null);

  const recipients = Array.from(
    new Set(
      (roleRows ?? [])
        .map((r: { work_email?: string | null }) => (r.work_email ?? "").trim().toLowerCase())
        .filter(Boolean),
    ),
  );

  if (recipients.length === 0) {
    return NextResponse.json({ created: 0, note: "No HR/admin recipients found" });
  }

  // 4. Build inserts for un-notified submissions
  const toInsert: {
    recipient_email: string;
    type: string;
    tone: string;
    title: string;
    message: string;
    details: Record<string, unknown>;
    created_at?: string;
  }[] = [];

  for (const sub of submissions as {
    id: string;
    full_name?: string | null;
    invite_personal_email?: string | null;
    email?: string | null;
    invite_department?: string | null;
    submitted_at?: string | null;
  }[]) {
    if (alreadyNotified.has(sub.id)) continue;
    const fullName = sub.full_name?.trim() || "Unknown";
    const dept = sub.invite_department ?? null;
    const deptSuffix = dept ? ` for ${dept}` : "";
    for (const to of recipients) {
      toInsert.push({
        recipient_email: to,
        type: "onboarding.submitted",
        tone: "positive",
        title: "New Onboarding Submission",
        message: `${fullName} completed their onboarding paperwork${deptSuffix}. Review it in Onboarding -> Onboarding Form.`,
        details: {
          submission_id: sub.id,
          full_name: fullName,
          personal_email: sub.invite_personal_email ?? sub.email ?? null,
          department: dept,
          submitted_at: sub.submitted_at ?? null,
        },
        ...(sub.submitted_at ? { created_at: sub.submitted_at } : {}),
      });
    }
  }

  if (toInsert.length === 0) {
    return NextResponse.json({ created: 0 });
  }

  const { error: insertErr } = await supabase
    .from("employee_notifications")
    .insert(toInsert);

  if (insertErr) {
    return NextResponse.json({ created: 0, error: insertErr.message }, { status: 500 });
  }

  return NextResponse.json({ created: toInsert.length / recipients.length });
}
