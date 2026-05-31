import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import {
  deniedResponse,
  requireElevatedSession,
} from "@/lib/auth/authorize-email";
import {
  OFFBOARD_DEACTIVATE_SLUG,
  OFFBOARD_DELETE_SLUG,
  fireOffboardWebhook,
  isLeadGenDepartment,
  scheduledDeletionFrom,
} from "@/lib/hr/offboard-webhooks";
import { appendOffboardedSheetRow } from "@/lib/google-sheets/append-offboarded-sheet";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// The offboarding webhooks respond "when the last node finishes" (deactivate
// suspends the Workspace account AND sends the termination email synchronously),
// which can take well over the old 8s budget. Give the function headroom so
// Vercel doesn't kill it before n8n replies.
export const maxDuration = 30;

const MASTER_TABLE =
  process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE?.trim() || "global_master_list";

/** Reasons HR can pick when off-boarding. Free-text notes are stored separately
 *  in `off_boarded_note`. "other" requires a non-empty note. */
const VALID_REASONS = [
  "resigned",
  "performance",
  "time_manipulation",
  "attendance",
  "end_of_contract",
  "other",
] as const;
type Reason = (typeof VALID_REASONS)[number];

function getClient() {
  return createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
}

/**
 * POST /api/hr/offboard
 *
 * Body: { work_email: string; reason: Reason; note?: string }
 *
 * Marks every `global_master_list` row matching `work_email` as off-boarded
 * (off_boarded_at = now()), so `active_employees` drops them from every
 * downstream dashboard immediately. History is retained -- rows are NOT deleted.
 *
 * Then fires the department-aware account teardown:
 *   Lead Gen (all of the person's departments are Lead Gen) -> fire
 *     offboarding_delete now; no deletion timer.
 *   Other departments -> fire offboarding_deactivate now AND stamp
 *     scheduled_deletion_at = off_boarded_at + 14d; the daily cron fires
 *     offboarding_delete once the timer elapses.
 *
 * Response keeps a single `webhook` object (the one that fired) so the HR
 * Offboarding dialog's success/warning toast keeps working unchanged.
 */
export async function POST(req: Request) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  let body: { work_email?: string; reason?: string; note?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const work_email = body.work_email?.trim().toLowerCase();
  const reason = body.reason?.trim() as Reason | undefined;
  const note = body.note?.trim() || null;

  if (!work_email) {
    return NextResponse.json({ error: "work_email is required" }, { status: 400 });
  }
  if (!reason || !VALID_REASONS.includes(reason)) {
    return NextResponse.json(
      { error: `reason is required and must be one of: ${VALID_REASONS.join(", ")}` },
      { status: 400 },
    );
  }
  if (reason === "other" && !note) {
    return NextResponse.json(
      { error: 'When reason is "other", a free-text note is required.' },
      { status: 400 },
    );
  }

  const supabase = getClient();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
  }

  // Look at the still-active rows first so we know which departments this person
  // belongs to before deciding the teardown mode. Matches the update below
  // (work_email, off_boarded_at IS NULL).
  const { data: activeRows, error: lookupErr } = await supabase
    .from(MASTER_TABLE)
    .select('"Department"')
    .ilike('"Work Email"', work_email)
    .is("off_boarded_at", null);
  if (lookupErr) {
    return NextResponse.json({ error: lookupErr.message }, { status: 500 });
  }
  if (!activeRows || activeRows.length === 0) {
    return NextResponse.json(
      {
        error:
          "No active master-list row found for that email. They may already be off-boarded, or the email doesn't exist on the roster.",
      },
      { status: 404 },
    );
  }

  const lookupDepartments = (activeRows as Array<{ Department: string | null }>)
    .map((r) => r.Department)
    .filter((d): d is string => !!d);

  // Lead Gen (immediate delete) only when EVERY department this person holds is
  // Lead Gen. If any role is non-Lead-Gen, defer deletion 14 days (the safer
  // path -- the Workspace account is still tied to a non-Lead-Gen role).
  const allLeadGen =
    lookupDepartments.length > 0 && lookupDepartments.every(isLeadGenDepartment);
  const deletionMode: "immediate" | "delayed_14d" = allLeadGen
    ? "immediate"
    : "delayed_14d";

  const offBoardedAt = new Date().toISOString();
  const scheduledDeletionAt = allLeadGen ? null : scheduledDeletionFrom(offBoardedAt);

  // Stamp off_boarded_* (and the deletion timer for non-Lead-Gen) on every active
  // row for this work_email. Covers dual-role employees with multiple rows.
  const { data, error } = await supabase
    .from(MASTER_TABLE)
    .update({
      off_boarded_at: offBoardedAt,
      off_boarded_reason: reason,
      off_boarded_by: authz.sessionEmail,
      off_boarded_note: note,
      scheduled_deletion_at: scheduledDeletionAt,
      deletion_processed_at: null,
    })
    .ilike('"Work Email"', work_email)
    .is("off_boarded_at", null) // don't re-stamp already-offboarded rows
    .select('id, "Name", "Personal Email", "Work Email", "Department", "Start Date"');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as Array<{
    id: unknown;
    Name: string | null;
    "Personal Email": string | null;
    "Work Email": string | null;
    Department: string | null;
    "Start Date": string | null;
  }>;

  if (rows.length === 0) {
    return NextResponse.json(
      {
        error:
          "No active master-list row found for that email. They may already be off-boarded, or the email doesn't exist on the roster.",
      },
      { status: 404 },
    );
  }

  const first = rows[0]!;
  const departments = Array.from(
    new Set(rows.map((r) => r.Department).filter((d): d is string => !!d)),
  );

  // Insert into offboarded_sheet immediately so the HR Offboarded tab shows
  // the person without waiting for the nightly cron. Best-effort — don't block
  // the offboard response if Supabase or the Sheet write fails.
  const sheetInput = {
    personalEmail: first["Personal Email"] ?? "",
    workEmail: work_email,
    name: first.Name,
    department: departments.join(", ") || null,
    startDate: first["Start Date"],
    offBoardedAt: offBoardedAt,
    offBoardedReason: reason,
    offBoardedNote: note,
    offBoardedBy: authz.sessionEmail,
  };

  void (async () => {
    try {
      await supabase.from("offboarded_sheet").insert({
        personal_email: sheetInput.personalEmail,
        work_email: sheetInput.workEmail,
        name: sheetInput.name,
        department: sheetInput.department,
        start_date: sheetInput.startDate,
        off_boarded_at: sheetInput.offBoardedAt,
        off_boarded_reason: sheetInput.offBoardedReason,
        off_boarded_note: sheetInput.offBoardedNote,
        off_boarded_by: sheetInput.offBoardedBy,
      });
    } catch (e) {
      console.error("[offboard] offboarded_sheet insert failed:", e);
    }
    try {
      await appendOffboardedSheetRow(sheetInput);
    } catch (e) {
      console.error("[offboard] Google Sheet Offboarded append failed:", e);
    }
  })();

  // Fire the immediate teardown webhook. Lead Gen -> delete now; others ->
  // deactivate now (n8n suspends the account, sends the email, and removes the
  // Hubstaff member at pay_rate 0). Best-effort: the DB write above is the source
  // of truth, so a webhook failure never blocks the off-board.
  const slug = allLeadGen ? OFFBOARD_DELETE_SLUG : OFFBOARD_DEACTIVATE_SLUG;
  const webhook = await fireOffboardWebhook(slug, {
    event: "employee.offboarded",
    phase: allLeadGen ? "delete" : "deactivate",
    deletion_mode: deletionMode,
    hubstaff_pay_rate: 0,
    work_email,
    personal_email: first["Personal Email"],
    name: first.Name,
    departments,
    start_date: first["Start Date"],
    reason,
    note,
    off_boarded_at: offBoardedAt,
    scheduled_deletion_at: scheduledDeletionAt,
    off_boarded_by: authz.sessionEmail,
    rows_updated: rows.length,
  });

  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: "hr",
    action: "hr.employee.offboarded",
    resource: MASTER_TABLE,
    resource_id: work_email,
    details: {
      target_email: work_email,
      reason,
      note,
      rows_updated: rows.length,
      deletion_mode: deletionMode,
      scheduled_deletion_at: scheduledDeletionAt,
      webhook_slug: slug,
      webhook_fired: webhook.fired && webhook.error == null,
      webhook_status: webhook.status,
      webhook_error: webhook.error,
    },
  });

  return NextResponse.json({
    success: true,
    rows_updated: rows.length,
    deletion_mode: deletionMode,
    scheduled_deletion_at: scheduledDeletionAt,
    webhook,
  });
}
