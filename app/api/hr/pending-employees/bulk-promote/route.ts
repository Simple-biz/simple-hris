import { NextResponse } from "next/server";
import {
  listReadyLeadGenHires,
  promoteHrPendingEmployee,
} from "@/lib/supabase/hr-pending-employees";
import { backfillEmployeeIds } from "@/lib/supabase/backfill-employee-ids";
import { appendMasterSheetRows } from "@/lib/google-sheets/append-master-sheet";
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
 * The expensive external work is hoisted OUT of the per-row loop:
 *  - employee_id backfill runs ONCE after the loop (it re-scans the whole
 *    roster, so per-row would be O(N x roster)).
 *  - the Google Sheet append runs ONCE for the whole batch
 *    (appendMasterSheetRows: one read + one multi-row write + one format call).
 *    Appending per-row used to re-read the entire sheet 3-4 times per hire,
 *    which serialized past the 60s function limit and returned 504 for a dozen
 *    hires. The single-row promote route is unchanged.
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

  // Collected for the single batched Sheet append after the loop. `index` points
  // back into `results` so we can stamp each row's sheetAppended outcome.
  const sheetQueue: Array<{
    index: number;
    name: string;
    personalEmail: string;
    workEmail: string;
    department: string;
    startDate: string | null;
    phoneNumber: string | null;
    location: string | null;
  }> = [];

  for (const row of rows) {
    // skipSheet:true -- the Sheet append is batched once below, not per hire.
    const res = await promoteHrPendingEmployee(row.id, {
      skipBackfill: true,
      skipSheet: true,
    });
    const ok = !res.error;
    const index = results.length;
    results.push({
      id: row.id,
      name: res.row?.name ?? row.name,
      ok,
      error: res.error,
      sheetAppended: null,
    });
    if (ok && res.row?.work_email) {
      sheetQueue.push({
        index,
        name: res.row.name,
        personalEmail: res.row.personal_email,
        workEmail: res.row.work_email,
        department: res.row.department,
        startDate: res.startDate ?? res.row.start_date ?? null,
        phoneNumber: res.row.phone ?? null,
        location: res.row.location ?? null,
      });
    }
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

  // One batched Google Sheet append for every promoted hire (one read + one
  // multi-row write). Best-effort: a Sheet failure never unwinds a promotion,
  // it just leaves sheetAppended=false so the UI can warn.
  if (sheetQueue.length > 0) {
    try {
      const sheetResults = await appendMasterSheetRows(
        sheetQueue.map((q) => ({
          name: q.name,
          personalEmail: q.personalEmail,
          workEmail: q.workEmail,
          department: q.department,
          startDate: q.startDate,
          phoneNumber: q.phoneNumber ?? undefined,
          location: q.location ?? undefined,
        })),
      );
      sheetResults.forEach((sr, i) => {
        results[sheetQueue[i].index].sheetAppended = sr.appended;
      });
    } catch (e) {
      console.warn(
        `[bulk-promote] batched master-sheet append skipped: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      for (const q of sheetQueue) results[q.index].sheetAppended = false;
    }
  }

  return NextResponse.json({
    promoted: promotedCount,
    failed: results.length - promotedCount,
    total: results.length,
    results,
  });
}
