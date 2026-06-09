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
 * Two modes:
 *  - Body `{ ids: number[] }` — promote exactly those staged hires (any
 *    department). Used by the Ready tab's multi-select "Promote selected". The
 *    same per-row gates the single Promote button enforces (work email +
 *    orientation confirmed + status) are applied inside promoteHrPendingEmployee,
 *    so an ineligible id just comes back as a failed result.
 *  - No body — Lead-Gen-only batch: promotes every 'ready' Lead Gen hire that
 *    already has orientation confirmed + a work email.
 *
 * Either way it runs SEQUENTIALLY -- each promote inserts/reuses a master-list
 * row and the per-call employee_id backfill is skipped, then a single backfill
 * runs after the loop (the backfill re-scans the whole roster, so running it per
 * row would be O(N x roster)). The single-row promote route is unchanged.
 */
export async function POST(req: Request) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  // Optional explicit id list (multi-select). Tolerate an empty/malformed body.
  let ids: number[] | null = null;
  try {
    const body = (await req.json()) as { ids?: unknown };
    if (Array.isArray(body?.ids)) {
      ids = body.ids
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n > 0);
    }
  } catch {
    // no body — fall through to Lead Gen batch mode
  }

  let rows: Array<{ id: number; name: string }>;
  if (ids !== null) {
    if (ids.length === 0) {
      return NextResponse.json(
        { promoted: 0, failed: 0, total: 0, results: [], message: "No hires selected." },
      );
    }
    // promoteHrPendingEmployee resolves + gates each row itself; the name is
    // filled from its result below, so a placeholder is enough here.
    rows = ids.map((id) => ({ id, name: `#${id}` }));
  } else {
    const res = await listReadyLeadGenHires();
    if (res.error) {
      return NextResponse.json({ error: res.error }, { status: 500 });
    }
    if (res.rows.length === 0) {
      return NextResponse.json({
        promoted: 0,
        failed: 0,
        total: 0,
        results: [],
        message: "No Lead Gen hires are ready to promote (need orientation confirmed + work email).",
      });
    }
    rows = res.rows;
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
      name: res.row?.name ?? row.name,
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
