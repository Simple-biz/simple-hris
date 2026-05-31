import { NextResponse } from "next/server";
import {
  createSupabaseServiceRoleClient,
  createSupabaseServerClient,
} from "@/lib/supabase/server";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";
import {
  OFFBOARD_DEACTIVATE_SLUG,
  OFFBOARD_DELETE_SLUG,
  fireOffboardWebhook,
} from "@/lib/hr/offboard-webhooks";
import { deleteMasterSheetRowsByEmail } from "@/lib/google-sheets/delete-master-sheet-rows";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const MASTER_TABLE =
  process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE?.trim() || "global_master_list";

function getClient() {
  return createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
}

/**
 * POST /api/hr/offboard-fire-webhook
 *
 * Body: { work_email: string; action: "deactivate" | "delete" }
 *
 * Manually fires either the deactivate or delete offboarding webhook for a
 * person who has already been off-boarded in the DB. Useful when the original
 * webhook failed (e.g. n8n returned 500) and HR needs to re-trigger it.
 *
 * Looks up the person's current data from global_master_list so the webhook
 * payload is always fresh (name, departments, off_boarded_at, etc.).
 */
export async function POST(req: Request) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  let body: { work_email?: string; action?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const work_email = body.work_email?.trim().toLowerCase() ?? "";
  const action = body.action?.trim();

  if (!work_email) {
    return NextResponse.json({ error: "work_email is required" }, { status: 400 });
  }
  if (action !== "deactivate" && action !== "delete") {
    return NextResponse.json(
      { error: 'action must be "deactivate" or "delete"' },
      { status: 400 },
    );
  }

  const supabase = getClient();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
  }

  // Look up all rows for this work_email (including off-boarded) to build the
  // webhook payload with current data.
  const { data: rows, error: lookupErr } = await supabase
    .from(MASTER_TABLE)
    .select('"Name", "Personal Email", "Work Email", "Department", "Start Date", off_boarded_at, off_boarded_reason, off_boarded_note, off_boarded_by')
    .ilike('"Work Email"', work_email);

  if (lookupErr) {
    return NextResponse.json({ error: lookupErr.message }, { status: 500 });
  }
  if (!rows || rows.length === 0) {
    return NextResponse.json(
      { error: "No master-list row found for that email." },
      { status: 404 },
    );
  }

  type MasterRow = {
    Name: string | null;
    "Personal Email": string | null;
    "Work Email": string | null;
    Department: string | null;
    "Start Date": string | null;
    off_boarded_at: string | null;
    off_boarded_reason: string | null;
    off_boarded_note: string | null;
    off_boarded_by: string | null;
  };
  const typed = rows as MasterRow[];
  const first = typed[0]!;

  const departments = Array.from(
    new Set(typed.map((r) => r.Department).filter((d): d is string => !!d)),
  );

  const slug = action === "delete" ? OFFBOARD_DELETE_SLUG : OFFBOARD_DEACTIVATE_SLUG;

  const webhook = await fireOffboardWebhook(slug, {
    event: "employee.offboarded",
    phase: action,
    triggered_by: "manual_hr",
    hubstaff_pay_rate: 0,
    work_email,
    personal_email: first["Personal Email"],
    name: first.Name,
    departments,
    start_date: first["Start Date"],
    reason: first.off_boarded_reason,
    note: first.off_boarded_note,
    off_boarded_at: first.off_boarded_at,
    off_boarded_by: authz.sessionEmail,
    fired_by: authz.sessionEmail,
  });

  // When deleting, also remove the person from the Google Sheet Master List so
  // the next sync-master-from-sheet cron doesn't re-activate them.
  let sheetDelete: { deleted: number; reason?: string; error?: string } | null = null;
  if (action === "delete") {
    try {
      sheetDelete = await deleteMasterSheetRowsByEmail(
        first["Personal Email"] ?? "",
        work_email,
      );
    } catch (e) {
      sheetDelete = { deleted: 0, error: e instanceof Error ? e.message : String(e) };
    }
  }

  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: "hr",
    action: `hr.employee.webhook_fired.${action}`,
    resource: MASTER_TABLE,
    resource_id: work_email,
    details: {
      work_email,
      action,
      webhook_slug: slug,
      webhook_fired: webhook.fired && webhook.error == null,
      webhook_status: webhook.status,
      webhook_error: webhook.error,
      sheet_rows_deleted: sheetDelete?.deleted ?? null,
      sheet_delete_error: sheetDelete?.error ?? null,
    },
  });

  return NextResponse.json({ success: true, action, webhook, sheet_delete: sheetDelete });
}
