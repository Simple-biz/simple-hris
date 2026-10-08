import { NextResponse } from "next/server";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { getHrChecklistPeriod } from "@/lib/supabase/hr-new-hire-checklist";
import {
  getSourceRow,
  listHeldSourceRows,
  listSourceRows,
  probeHiresSyncTables,
  type SourceRow,
} from "@/lib/supabase/hr-new-hire-source-db";
import { readHiresSourceConfig } from "@/lib/hr/hires-source-config";
import type { HeldHire, SyncedHire } from "@/lib/hr/hires-source-map";
import { placeHeldSourceHire, runHiresSourceSync } from "@/lib/hr/hires-source-sync";

/**
 * The New Hire Checklist's hiring-database sync (docs/features/new-hire-source-sync.md).
 *
 *   GET                                      status + the held hires (elevated session)
 *   GET ?view=synced                         every hire in the HRIS copy + where it went (elevated)
 *   POST { action: 'sync', period_start }    one sync pass for the week on the selector (feature edit — it writes
 *                                            rows of THAT week only; Kane 2026-10-08, "(b) Only the week on screen")
 *   POST { action: 'place', source_key, period_start }
 *                                            HR places a held hire in an open week
 *
 * The open tab calls `sync` on mount, on every week change, every 30 s while visible, and on "Sync now".
 * Known states answer with a `status` the strip renders (not_configured / not_ready
 * / source_error), never a bare 500 in a toast.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toHeld(r: SourceRow): HeldHire {
  return {
    source_key: r.source_key,
    name: r.name,
    personal_email: r.personal_email,
    department: r.department,
    date_of_interview: r.date_of_interview,
    target_period_start: r.target_period_start,
    hold_reason: r.hold_reason,
    first_pulled_at: r.first_pulled_at,
    source_created_at: r.source_created_at,
  };
}

async function heldList(): Promise<{ held: HeldHire[]; heldError: string | null }> {
  const { rows, error } = await listHeldSourceRows();
  return { held: rows.map(toHeld), heldError: error };
}

function toSynced(r: SourceRow): SyncedHire {
  return {
    source_key: r.source_key,
    name: r.name,
    personal_email: r.personal_email,
    department: r.department,
    date_of_interview: r.date_of_interview,
    first_pulled_at: r.first_pulled_at,
    last_changed_at: r.last_changed_at,
    placement: r.placement,
    hold_reason: r.hold_reason,
    week: r.target_period_start,
    onChecklist: !!r.checklist_row_id,
  };
}

export async function GET(req: Request) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  // ?view=synced — every hire the sync has pulled into the HRIS copy, newest first
  // (the strip's "Synced data" list). Read on demand, never on the 30 s poll.
  if (new URL(req.url).searchParams.get("view") === "synced") {
    const { rows, error } = await listSourceRows();
    if (error) return NextResponse.json({ synced: [], error }, { status: 500 });
    const synced = rows
      .map(toSynced)
      .sort((a, b) => b.first_pulled_at.localeCompare(a.first_pulled_at) || a.source_key.localeCompare(b.source_key));
    return NextResponse.json({ synced, error: null });
  }

  const cfg = readHiresSourceConfig();
  const probe = await probeHiresSyncTables();
  const { held, heldError } = probe.ready ? await heldList() : { held: [], heldError: null };
  return NextResponse.json({
    configured: cfg.ok,
    configReason: cfg.ok ? null : cfg.reason,
    missing: cfg.ok ? [] : cfg.missing,
    tableReady: probe.ready,
    tableReason: probe.reason,
    held,
    heldError,
  });
}

export async function POST(req: Request) {
  const authz = await requireFeatureEdit("hr", "new_hire_checklist");
  if (!authz.ok) return deniedResponse(authz);

  let body: { action?: string; source_key?: unknown; period_start?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.action === "place") {
    const sourceKey = typeof body.source_key === "string" ? body.source_key.trim() : "";
    const period = typeof body.period_start === "string" ? body.period_start.trim() : "";
    if (!sourceKey) return NextResponse.json({ error: "source_key is required" }, { status: 400 });
    if (!ISO_DATE.test(period) || new Date(`${period}T00:00:00Z`).getUTCDay() !== 0) {
      return NextResponse.json({ error: "period_start must be a week's Sunday (YYYY-MM-DD)" }, { status: 400 });
    }
    const state = await getHrChecklistPeriod(period);
    if (state.error) return NextResponse.json({ error: state.error }, { status: 500 });
    const res = await placeHeldSourceHire({
      sourceKey,
      period,
      isWeekLocked: state.period?.status === "locked",
      actor: authz.sessionEmail,
      getRow: getSourceRow,
    });
    if (!res.ok) return NextResponse.json({ error: res.reason }, { status: res.status });
    void insertAuditLog({
      user_name: authz.sessionEmail,
      user_role: authz.roles[0] ?? "hr",
      action: "hr.new_hire_checklist.source_placed",
      resource: "hr_new_hire_checklist",
      resource_id: res.rowId,
      details: { period, source_key: sourceKey },
    });
    return NextResponse.json({ ok: true, rowId: res.rowId, period: res.period, ...(await heldList()) });
  }

  if (body.action !== "sync") {
    return NextResponse.json({ error: "action must be 'sync' or 'place'" }, { status: 400 });
  }

  // A pass syncs ONE week, the one on the selector; there is no "every week" pass to fall back to.
  const selectedWeek = typeof body.period_start === "string" ? body.period_start.trim() : "";
  if (!ISO_DATE.test(selectedWeek) || new Date(`${selectedWeek}T00:00:00Z`).getUTCDay() !== 0) {
    return NextResponse.json({ error: "period_start must be the selected week's Sunday (YYYY-MM-DD)" }, { status: 400 });
  }

  const result = await runHiresSourceSync({ selectedWeek });
  if (result.status !== "ok") {
    const code =
      result.status === "not_configured" || result.status === "not_ready"
        ? 503
        : result.status === "source_error"
          ? 502
          : 500;
    return NextResponse.json(result, { status: code });
  }

  const s = result.summary;
  // Audited only when the pass CHANGED the checklist — a 30-second poll that finds
  // nothing new must not bury the audit log.
  if (s.placed + s.linked + s.updatedCells > 0) {
    void insertAuditLog({
      user_name: authz.sessionEmail,
      user_role: authz.roles[0] ?? "hr",
      action: "hr.new_hire_checklist.source_synced",
      resource: "hr_new_hire_checklist",
      resource_id: s.touchedWeeks[0] ?? "hires-sync",
      details: {
        week: s.week,
        pulled: s.pulled,
        new_rows: s.newRows,
        changed_rows: s.changedRows,
        placed: s.placed,
        linked: s.linked,
        held: s.held,
        deferred: s.deferred,
        updated_cells: s.updatedCells,
        weeks: s.touchedWeeks,
        truncated: s.truncated,
        skipped_no_id: s.skippedNoId,
        errors: s.errors.slice(0, 20),
      },
    });
  }
  return NextResponse.json({ ...result, ...(await heldList()) });
}
