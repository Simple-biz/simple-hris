import { NextResponse } from "next/server";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { offboardReasonLabel } from "@/lib/hr/offboard-reasons";
import {
  backfillOffboardedSheet,
  type OffboardedMasterRecord,
} from "@/lib/google-sheets/backfill-offboarded-sheet";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MASTER_TABLE =
  process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE?.trim() || "global_master_list";

const SELECT_COLS =
  'id, "Personal Email", "Work Email", "Start Date", city, province, full_address, "Location", "Phone Number", off_boarded_at, off_boarded_reason';

interface MasterRow {
  "Personal Email": string | null;
  "Work Email": string | null;
  "Start Date": string | null;
  city: string | null;
  province: string | null;
  full_address: string | null;
  Location: string | null;
  "Phone Number": string | null;
  off_boarded_at: string | null;
  off_boarded_reason: string | null;
}

function buildLocation(r: MasterRow): string | null {
  return (
    [r.city, r.province].map((s) => s?.trim()).filter(Boolean).join(", ") ||
    r.full_address?.trim() ||
    r.Location?.trim() ||
    null
  );
}

function toRecord(r: MasterRow): OffboardedMasterRecord {
  return {
    location: buildLocation(r),
    phone: r["Phone Number"]?.trim() || null,
    startDate: r["Start Date"]?.trim() || null,
    reasonLabel: r.off_boarded_reason ? offboardReasonLabel(r.off_boarded_reason) : null,
    offBoardedAt: r.off_boarded_at ?? null,
  };
}

/** Fill any null fields of `base` from `next` (dual-role people have >1 row). */
function mergeRecord(base: OffboardedMasterRecord, next: OffboardedMasterRecord): OffboardedMasterRecord {
  return {
    location: base.location ?? next.location,
    phone: base.phone ?? next.phone,
    startDate: base.startDate ?? next.startDate,
    reasonLabel: base.reasonLabel ?? next.reasonLabel,
    offBoardedAt: base.offBoardedAt ?? next.offBoardedAt,
  };
}

/**
 * POST /api/hr/offboard-sheet-backfill
 *
 * Body: { apply?: boolean }  — defaults to a DRY RUN (apply=false).
 *
 * Fills the blank Location / Contact Number / Start Date / Offboard Reason /
 * Offboarded Date cells in the Google "Offboarded" tab from the master record,
 * matched on personal (then work) email. Only blank cells are touched, so any
 * value HR typed by hand is preserved. Pass `{ "apply": true }` to write; omit
 * it to preview the exact cell changes first.
 */
export async function POST(req: Request) {
  const authz = await requireFeatureEdit("hr", "offboarding");
  if (!authz.ok) return deniedResponse(authz);

  let body: { apply?: unknown };
  try {
    body = (await req.json().catch(() => ({}))) as typeof body;
  } catch {
    body = {};
  }
  const apply = body.apply === true;

  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
  }

  // Index every off-boarded master row by lowercased personal + work email.
  const byEmail = new Map<string, OffboardedMasterRecord>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(MASTER_TABLE)
      .select(SELECT_COLS)
      .not("off_boarded_at", "is", null)
      .range(from, from + PAGE - 1);
    if (error) {
      return NextResponse.json({ error: `Master read failed: ${error.message}` }, { status: 500 });
    }
    const rows = (data ?? []) as unknown as MasterRow[];
    for (const r of rows) {
      const rec = toRecord(r);
      for (const key of [r["Personal Email"], r["Work Email"]]) {
        const k = key?.trim().toLowerCase();
        if (!k) continue;
        const prev = byEmail.get(k);
        byEmail.set(k, prev ? mergeRecord(prev, rec) : rec);
      }
    }
    if (rows.length < PAGE) break;
  }

  let result;
  try {
    result = await backfillOffboardedSheet(
      (personal, work) => byEmail.get(personal) ?? byEmail.get(work) ?? null,
      { dryRun: !apply },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }

  if (apply) {
    void insertAuditLog({
      user_name: authz.sessionEmail,
      user_role: "hr",
      action: "hr.offboarded_sheet.backfilled",
      resource: "google_sheet_offboarded",
      resource_id: MASTER_TABLE,
      details: {
        scanned_rows: result.scannedRows,
        matched_rows: result.matchedRows,
        filled_cells: result.filledCells,
        by_field: result.byField,
        unmatched_count: result.unmatched.length,
      },
    });
  }

  return NextResponse.json({
    success: true,
    apply,
    masterOffboardedIndexed: byEmail.size,
    ...result,
  });
}
