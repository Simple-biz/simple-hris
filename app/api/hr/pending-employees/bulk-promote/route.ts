import { NextResponse } from "next/server";
import {
  listReadyLeadGenHires,
  promoteHrPendingEmployee,
  setHrPromotionOutcome,
  sheetWriteSucceeded,
} from "@/lib/supabase/hr-pending-employees";
import { backfillEmployeeIds } from "@/lib/supabase/backfill-employee-ids";
import {
  appendMasterSheetRows,
  type AppendMasterRowResult,
} from "@/lib/google-sheets/append-master-sheet";
import { masterListDisplayName } from "@/lib/name/display-name";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";
import { insertAuditLog } from "@/lib/supabase/audit-log";

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
  const authz = await requireFeatureEdit('hr', 'onboarding');
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

  type RowResult = {
    id: number;
    name: string;
    ok: boolean;
    error: string | null;
    sheetAppended: boolean | null;
  };

  // Phase 1 — PREPARE every hire (master-list insert/reuse + payout/rate
  // side-effects) WITHOUT flipping its status. deferStatus:true leaves the
  // pending row 'ready' so nothing is marked 'promoted' before we know its Sheet
  // row actually landed. Run in parallel with a small concurrency cap: each
  // prepare is several Supabase round-trips and they're independent (distinct
  // work emails -> no master-row collision), so a sequential loop was the main
  // source of the slow multi-promote.
  type Prepared =
    | {
        kind: "ok";
        id: number;
        name: string;
        masterId: string;
        sheetInput: {
          name: string;
          personalEmail: string;
          workEmail: string;
          department: string;
          startDate: string | null;
          phoneNumber: string | null;
          location: string | null;
        };
      }
    | { kind: "fail"; id: number; name: string; error: string };

  const prepared = await mapWithConcurrency(rows, 5, async (row): Promise<Prepared> => {
    try {
      // skipSheet:true -- the Sheet append is batched once below, not per hire.
      // deferStatus:true -- the status flip happens in phase 3, gated on the Sheet.
      const res = await promoteHrPendingEmployee(row.id, {
        skipBackfill: true,
        skipSheet: true,
        deferStatus: true,
      });
      if (res.error || !res.masterId || !res.row?.work_email) {
        return {
          kind: "fail",
          id: row.id,
          name: res.row?.name ?? row.name,
          error: res.error ?? "Could not stage the master-list row.",
        };
      }
      return {
        kind: "ok",
        id: row.id,
        name: res.row.name,
        masterId: res.masterId,
        sheetInput: {
          name: res.row.name,
          personalEmail: res.row.personal_email,
          workEmail: res.row.work_email,
          department: res.row.department,
          startDate: res.startDate ?? res.row.start_date ?? null,
          phoneNumber: res.row.phone ?? null,
          location: res.row.location ?? null,
        },
      };
    } catch (e) {
      // A thrown prepare (e.g. transient DB error) shouldn't sink the whole
      // batch — record it as a per-row failure so the rest still promote.
      return {
        kind: "fail",
        id: row.id,
        name: row.name,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });

  const okPrepared = prepared.filter(
    (p): p is Extract<Prepared, { kind: "ok" }> => p.kind === "ok",
  );

  // Single employee_id backfill for the whole batch (skipped per-row above).
  if (okPrepared.length > 0) {
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

  // Phase 2 — ONE batched Google Sheet append for every prepared hire (one read
  // + one multi-row write). A thrown read/write failure means NONE of them
  // landed on the Sheet, so every prepared hire is treated as a Sheet failure
  // (and finalized to 'failed_to_promote' below), never silently 'promoted'.
  let sheetResults: AppendMasterRowResult[] = okPrepared.map(() => ({
    appended: false,
    reason: "sheet append not attempted",
  }));
  if (okPrepared.length > 0) {
    try {
      sheetResults = await appendMasterSheetRows(
        okPrepared.map((p) => ({
          // Surname-first, nickname-quoted form (e.g. `Reroma, Jan Kane "Kane"`)
          // so the bulk batch posts the SAME format to the master Sheet that the
          // master-list "Name" insert (inside promote) and the Submitted tab use.
          name: masterListDisplayName(p.sheetInput.name),
          personalEmail: p.sheetInput.personalEmail,
          workEmail: p.sheetInput.workEmail,
          department: p.sheetInput.department,
          startDate: p.sheetInput.startDate,
          phoneNumber: p.sheetInput.phoneNumber ?? undefined,
          location: p.sheetInput.location ?? undefined,
        })),
      );
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.warn(`[bulk-promote] batched master-sheet append failed: ${reason}`);
      sheetResults = okPrepared.map(() => ({ appended: false, reason }));
    }
  }

  // Phase 3 — FINALIZE each hire's status now that the Sheet outcome is known.
  // 'promoted' only when its Sheet row landed (or was already present);
  // otherwise 'failed_to_promote' (red, retryable). Run the status writes in
  // parallel — they're independent single-row updates.
  const byId = new Map<number, RowResult>();
  await Promise.all([
    ...okPrepared.map(async (p, i) => {
      const ok = sheetWriteSucceeded(sheetResults[i]);
      const { error } = await setHrPromotionOutcome(p.id, {
        promoted: ok,
        masterId: p.masterId,
      });
      byId.set(p.id, {
        id: p.id,
        name: p.name,
        ok: ok && !error,
        error: error
          ? `Status update failed: ${error}`
          : ok
            ? null
            : `Google Sheet write failed: ${sheetResults[i]?.reason ?? "unknown error"}`,
        sheetAppended: sheetResults[i]?.appended ?? false,
      });
    }),
    ...prepared
      .filter((p): p is Extract<Prepared, { kind: "fail" }> => p.kind === "fail")
      .map(async (p) => {
        await setHrPromotionOutcome(p.id, { promoted: false, masterId: null });
        byId.set(p.id, {
          id: p.id,
          name: p.name,
          ok: false,
          error: p.error,
          sheetAppended: null,
        });
      }),
  ]);

  // Preserve the caller's row order in the response.
  const results: RowResult[] = rows.map(
    (r) =>
      byId.get(r.id) ?? {
        id: r.id,
        name: r.name,
        ok: false,
        error: "No result recorded.",
        sheetAppended: null,
      },
  );
  const promotedCount = results.filter((r) => r.ok).length;

  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: authz.roles[0] ?? "hr",
    action: "hr.pending.bulk_promoted",
    resource: "hr_pending_employees",
    resource_id: null,
    details: {
      mode: ids !== null ? "selected" : "lead_gen",
      total: results.length,
      promoted: promotedCount,
      failed: results.length - promotedCount,
      ids: results.map((r) => r.id),
      failures: results
        .filter((r) => !r.ok)
        .map((r) => ({ id: r.id, name: r.name, error: r.error })),
    },
  });

  return NextResponse.json({
    promoted: promotedCount,
    failed: results.length - promotedCount,
    total: results.length,
    results,
  });
}

/** Run `fn` over `items` with at most `limit` in flight at once, preserving order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
