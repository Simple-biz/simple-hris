import { NextResponse } from "next/server";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";
import { deleteMasterSheetRowsByEmail } from "@/lib/google-sheets/delete-master-sheet-rows";
import { deleteOffboardedSheetRowsByEmail } from "@/lib/google-sheets/delete-offboarded-sheet-rows";
import { deleteOffboardedSheetByEmails } from "@/lib/supabase/global-master-list-db";
import { insertAuditLog } from "@/lib/supabase/audit-log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/hr/offboard-sheet-delete
 *
 * Body: { work_email: string; personal_email?: string }
 *
 * Removes the person from the Google Sheet so they stop reappearing in the HR
 * Offboarded list. Three deletes, each best-effort and independent:
 *
 *   1. Offboarded tab        -- the tab that feeds the offboarded_sheet snapshot.
 *      Deleting here is what stops the next sync-offboarded-from-sheet cron from
 *      re-adding them to the Offboarded list. (THE fix for "stays offboarded".)
 *   2. offboarded_sheet DB   -- the snapshot the HR Offboarded tab reads from.
 *      Deleting here makes the row disappear immediately, without waiting for a
 *      sync. Matched on work_email OR personal_email.
 *   3. Master List tab       -- so the sync-master-from-sheet cron won't
 *      re-activate them either.
 *
 * Never throws to the caller; returns granular counts. A deletion count of 0
 * (not found) is not an error -- the row may already have been removed.
 */
export async function POST(req: Request) {
  const authz = await requireFeatureEdit('hr', 'offboarding');
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

  // 1. Offboarded sheet tab -- the load-bearing delete for this feature.
  let offboardedTab = { deleted: 0, reason: undefined as string | undefined, error: null as string | null };
  try {
    const r = await deleteOffboardedSheetRowsByEmail(personal_email, work_email);
    offboardedTab = { deleted: r.deleted, reason: r.reason, error: null };
  } catch (e) {
    offboardedTab = { deleted: 0, reason: undefined, error: e instanceof Error ? e.message : String(e) };
  }

  // 2. offboarded_sheet snapshot table -- immediate removal from the HR list.
  let snapshotDeleted = 0;
  let snapshotError: string | null = null;
  try {
    snapshotDeleted = await deleteOffboardedSheetByEmails(work_email, personal_email);
  } catch (e) {
    snapshotError = e instanceof Error ? e.message : String(e);
  }

  // 3. Master List tab -- so the master sync won't re-activate them.
  let masterTab = { deleted: 0, reason: undefined as string | undefined, error: null as string | null };
  try {
    const r = await deleteMasterSheetRowsByEmail(personal_email, work_email);
    masterTab = { deleted: r.deleted, reason: r.reason, error: null };
  } catch (e) {
    masterTab = { deleted: 0, reason: undefined, error: e instanceof Error ? e.message : String(e) };
  }

  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: "hr",
    action: "hr.employee.removed_from_offboarded_sheet",
    resource: "google_sheet_offboarded",
    resource_id: work_email || personal_email,
    details: {
      work_email,
      personal_email,
      offboarded_tab_deleted: offboardedTab.deleted,
      offboarded_tab_error: offboardedTab.error,
      snapshot_deleted: snapshotDeleted,
      snapshot_error: snapshotError,
      master_tab_deleted: masterTab.deleted,
      master_tab_error: masterTab.error,
    },
  });

  // Total rows removed from the Google Sheet (across both tabs) -- this is what
  // the UI reports as "deleted".
  const sheetDeleted = offboardedTab.deleted + masterTab.deleted;

  return NextResponse.json({
    success: true,
    deleted: sheetDeleted,
    offboardedTab,
    masterTab,
    snapshotDeleted,
    snapshotError,
    // Combined "not found anywhere" reason for the toast when nothing matched.
    reason: sheetDeleted === 0 && snapshotDeleted === 0
      ? (offboardedTab.reason ?? masterTab.reason ?? "not found in sheet")
      : undefined,
  });
}
