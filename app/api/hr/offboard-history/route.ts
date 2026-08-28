import { NextResponse } from "next/server";
import { listOffboardedSheetRows } from "@/lib/supabase/global-master-list-db";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/hr/offboard-history
 *
 * Returns the off-boarded employee list backing the HR Offboarded tab — now the
 * ONE list, after the "Offboarded by HRIS" tab was merged into it (2026-08-28).
 *
 * Sourced entirely from the `offboarded_sheet` ledger, which is the superset:
 * `/api/hr/offboard` writes both that table and `offboarding_queue`, so all 488
 * completed queue rows already existed here and the queue contributed exactly
 * zero additional people. Merging is therefore a presentational join, not a
 * union — the queue is consulted client-side only to keep its per-row "delete
 * the request" cleanup action reachable.
 *
 * `origin` is what the merged tab's Origin column reads: 'hris' (written by the
 * HRIS offboarding flow) vs 'google_sheet' (off the master sheet's Offboarded
 * tab). It is a stored column, not a derivation — see the migration
 * (references/sql/migrate/2026-08-28_offboarded_sheet_origin.sql) for why the
 * old `off_boarded_by IS NULL` heuristic stopped being able to answer it.
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
      origin: r.origin,
    }));
    return NextResponse.json({ rows: mapped });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
