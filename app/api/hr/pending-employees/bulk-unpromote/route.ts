import { NextResponse } from "next/server";
import { bulkRevertHrPendingEmployeesToReady } from "@/lib/supabase/hr-pending-employees";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";
import { insertAuditLog } from "@/lib/supabase/audit-log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Each revert removes a master-list row; the Google Sheet removal is batched into
// one call, but give the batch headroom for a large multi-select.
export const maxDuration = 60;

/**
 * POST /api/hr/pending-employees/bulk-unpromote
 *
 * Body `{ ids: number[] }` — sends each `promoted` staged hire back to `ready`
 * (clears promoted_at + promoted_to_master_id, removes the global_master_list row
 * AND the master Google Sheet row). Powers the Promoted tab's multi-select "Back
 * to Ready". Mirrors the single-row [id]/unpromote endpoint; the per-row gate
 * (only a 'promoted' hire) is enforced inside the lib, so an ineligible id just
 * comes back as a failed result instead of sinking the batch.
 *
 * Returns nothing identity-sensitive (id/name/ok/error only) — no pay rates.
 */
export async function POST(req: Request) {
  const authz = await requireFeatureEdit("hr", "onboarding");
  if (!authz.ok) return deniedResponse(authz);

  let ids: number[] = [];
  try {
    const body = (await req.json()) as { ids?: unknown };
    if (Array.isArray(body?.ids)) {
      ids = body.ids.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
    }
  } catch {
    // no/invalid body — treated as an empty selection below
  }

  if (ids.length === 0) {
    return NextResponse.json({
      reverted: 0,
      failed: 0,
      total: 0,
      results: [],
      message: "No hires selected.",
    });
  }

  const out = await bulkRevertHrPendingEmployeesToReady(ids);

  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: authz.roles[0] ?? "hr",
    action: "hr.pending.bulk_unpromoted",
    resource: "hr_pending_employees",
    resource_id: null,
    details: {
      total: out.total,
      reverted: out.reverted,
      failed: out.failed,
      ids,
    },
  });

  return NextResponse.json(out);
}
