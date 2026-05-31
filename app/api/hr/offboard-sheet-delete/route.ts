import { NextResponse } from "next/server";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";
import { deleteMasterSheetRowsByEmail } from "@/lib/google-sheets/delete-master-sheet-rows";
import { insertAuditLog } from "@/lib/supabase/audit-log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/hr/offboard-sheet-delete
 *
 * Body: { work_email: string; personal_email?: string }
 *
 * Deletes the person's row(s) from the Google Sheet Master List tab so the
 * next sync-master-from-sheet cron won't re-activate them.
 *
 * Best-effort: returns { success, deleted, reason } and never throws to the
 * caller. A deletion count of 0 (not found) is not treated as an error —
 * the person may have already been removed manually from the sheet.
 */
export async function POST(req: Request) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  let body: { work_email?: string; personal_email?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const work_email = body.work_email?.trim().toLowerCase() ?? "";
  const personal_email = body.personal_email?.trim().toLowerCase() ?? "";

  if (!work_email && !personal_email) {
    return NextResponse.json(
      { error: "work_email or personal_email is required" },
      { status: 400 },
    );
  }

  try {
    const result = await deleteMasterSheetRowsByEmail(personal_email, work_email);

    void insertAuditLog({
      user_name: authz.sessionEmail,
      user_role: "hr",
      action: "hr.employee.removed_from_master_sheet",
      resource: "google_sheet_master_list",
      resource_id: work_email || personal_email,
      details: {
        work_email,
        personal_email,
        rows_deleted: result.deleted,
        reason: result.reason ?? null,
      },
    });

    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
