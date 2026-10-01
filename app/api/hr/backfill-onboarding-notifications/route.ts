import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { auditActor } from "@/lib/audit/context";
import { selectAllPaged } from "@/lib/supabase/select-all-paged";
import { submissionsAlreadyNotified } from "@/lib/notifications/onboarding-backfill";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/hr/backfill-onboarding-notifications
 *
 * Creates missing `onboarding.submitted` notifications for all `submitted`
 * onboarding forms that don't already have one. Idempotent — deduped via
 * the submission_id stored in the details JSONB, asked PER SUBMISSION (see
 * `submissionsAlreadyNotified`), so re-running is safe. Runs on every HR
 * Notifications open. Gated to elevated (HR/admin) sessions.
 */
export async function POST() {
  const authz = await requireFeatureEdit('hr', 'onboarding');
  if (!authz.ok) return deniedResponse(authz);

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    return NextResponse.json({ created: 0, error: "DB unavailable" }, { status: 500 });
  }

  type SubmissionRow = {
    id: string;
    full_name?: string | null;
    invite_personal_email?: string | null;
    email?: string | null;
    invite_department?: string | null;
    submitted_at?: string | null;
  };

  // 1. All submitted forms (paged — PostgREST stops at 1000 rows)
  const { rows: submissions, error: subErr } = await selectAllPaged<SubmissionRow>((from, to) =>
    supabase
      .from("hr_onboarding_submissions")
      .select("id, full_name, invite_personal_email, email, invite_department, submitted_at")
      .eq("status", "submitted")
      .order("submitted_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to),
  );

  if (subErr) {
    return NextResponse.json({ created: 0, error: subErr }, { status: 500 });
  }
  if (submissions.length === 0) {
    return NextResponse.json({ created: 0 });
  }

  // 2. Which of THESE submissions already have a notification — one probe each.
  //    Never one read of every onboarding.submitted row: it stopped at 1000 of
  //    186,581 and re-sent all 7 pending submissions on every open (item 305).
  //    A failed probe inserts nothing.
  const already = await submissionsAlreadyNotified(
    submissions.map((s) => s.id),
    (submissionId) =>
      supabase
        .from("employee_notifications")
        .select("id")
        .eq("type", "onboarding.submitted")
        .eq("details->>submission_id", submissionId)
        .limit(1),
  );
  if (!already.ok) {
    return NextResponse.json({ created: 0, error: already.error }, { status: 500 });
  }
  const alreadyNotified = already.notified;

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

  for (const sub of submissions) {
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

  // A one-shot backfill that fans notifications out to every HR recipient —
  // rare, manual, and previously invisible. `POST()` takes no request object,
  // so there is no IP to record; the actor comes from the gate.
  void insertAuditLog({
    ...auditActor(authz),
    action: "hr.onboarding.notifications_backfilled",
    resource: "employee_notifications",
    resource_id: null,
    details: {
      rows_inserted: toInsert.length,
      recipients: recipients.length,
      submissions: recipients.length > 0 ? toInsert.length / recipients.length : 0,
    },
  });

  return NextResponse.json({ created: toInsert.length / recipients.length });
}
