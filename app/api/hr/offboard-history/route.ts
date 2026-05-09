import { NextResponse } from "next/server";
import { listOffboardedSheetRows } from "@/lib/supabase/global-master-list-db";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/hr/offboard-history
 *
 * Returns the off-boarded employee list backing the HR Offboarded tab. Sourced
 * from the `offboarded_sheet` table (a snapshot of the Offboarded tab of the
 * master Google Sheet, repopulated by /api/cron/sync-offboarded-from-sheet).
 *
 * The shape returned here matches the legacy global_master_list-backed payload
 * (Name / "Work Email" / "Personal Email" / Department / Start Date) so the
 * client `HistoryRow` type doesn't need to change.
 */
export async function GET() {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  try {
    const rows = await listOffboardedSheetRows();
    const mapped = rows.map((r) => ({
      id: String(r.id),
      Name: r.name,
      "Work Email": r.work_email,
      "Personal Email": r.personal_email,
      Department: r.department,
      "Start Date": r.start_date,
      off_boarded_at: r.off_boarded_at,
      off_boarded_reason: r.off_boarded_reason,
      off_boarded_by: r.off_boarded_by,
      off_boarded_note: r.off_boarded_note,
    }));
    return NextResponse.json({ rows: mapped });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
