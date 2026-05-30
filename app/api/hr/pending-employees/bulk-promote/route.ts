import { NextResponse } from "next/server";
import {
  listReadyLeadGenHires,
  promoteHrPendingEmployee,
} from "@/lib/supabase/hr-pending-employees";
import { backfillEmployeeIds } from "@/lib/supabase/backfill-employee-ids";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Promotes a weekly Lead Gen batch one row at a time; each promote fires a
// Hubstaff invite + Google Sheet append. Give it headroom for a ~50-hire batch.
export const maxDuration = 60;

/**
 * POST /api/hr/pending-employees/bulk-promote
 *
 * Lead-Gen-only bulk promote. Promotes every 'ready' Lead Gen hire that already
 * has orientation confirmed + a work email (the same gates the single-row
 * Promote button enforces). Runs SEQUENTIALLY -- each promote inserts/reuses a
 * master-list row and the per-call employee_id backfill is skipped, then a
 * single backfill runs after the loop (the backfill re-scans the whole roster,
 * so running it per row would be O(N x roster)).
 *
 * The single-row promote route is unchanged.
 */
export async function POST() {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const { rows, error } = await listReadyLeadGenHires();
  if (error) {
    return NextResponse.json({ error }, { status: 500 });
  }
  if (rows.length === 0) {
    return NextResponse.json({
      promoted: 0,
      failed: 0,
      total: 0,
      results: [],
      message: "No Lead Gen hires are ready to promote (need orientation confirmed + work email).",
    });
  }

  const results: Array<{
    id: number;
    name: string;
    ok: boolean;
    error: string | null;
    sheetAppended: boolean | null;
  }> = [];

  for (const row of rows) {
    const res = await promoteHrPendingEmployee(row.id, { skipBackfill: true });
    results.push({
      id: row.id,
      name: row.name,
      ok: !res.error,
      error: res.error,
      sheetAppended: res.sheet ? res.sheet.appended : null,
    });
  }

  // Single employee_id backfill for the whole batch (skipped per-row above).
  const promotedCount = results.filter((r) => r.ok).length;
  if (promotedCount > 0) {
    try {
      const sb = createSupabaseServiceRoleClient();
      if (sb) await backfillEmployeeIds(sb);
    } catch (e) {
      console.warn(
        `[bulk-promote] employee_id backfill skipped: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  return NextResponse.json({
    promoted: promotedCount,
    failed: results.length - promotedCount,
    total: results.length,
    results,
  });
}
