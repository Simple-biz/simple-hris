import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { requireElevatedSession, deniedResponse } from "@/lib/auth/authorize-email";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { invalidateRateProfilesCache } from "@/lib/supabase/employee-rate-profiles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RATES_TABLE =
  process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() ||
  "employee_hourly_rates";

function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : req.headers.get("x-real-ip");
}

function fmtIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * DELETE /api/employee-rate-history/[id] — revoke a single rate-history row.
 *
 * Admin-only. After deletion, if the deleted row was the most-recent-as-of-
 * today entry for the employee, the `employee_hourly_rates` cache is
 * re-synced to whichever remaining history row is now most-recent-as-of-
 * today. Past payroll cycles that already snapshotted rates (via
 * `disbursement_records.regular_rate_snapshot` etc.) are unaffected — only
 * the live cache changes.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ success: false, error: "supabase unavailable" }, { status: 500 });
  }

  // Look up the row first so we know which employee to re-sync. Also lets us
  // refuse to delete the baseline (1970-01-01) row — that's the safety net
  // for prorating, removing it would break rate-as-of lookups for anything
  // before the next-oldest history row.
  const { data: row, error: lookupErr } = await supabase
    .from("employee_rate_history")
    .select("id, employee_email, regular_rate, ot_rate, effective_from, note")
    .eq("id", id)
    .maybeSingle();
  if (lookupErr) {
    return NextResponse.json({ success: false, error: lookupErr.message }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json({ success: false, error: "not found" }, { status: 404 });
  }
  if (row.effective_from === "1970-01-01" || /baseline/i.test(row.note ?? "")) {
    return NextResponse.json(
      { success: false, error: "Cannot revoke the baseline rate row." },
      { status: 400 },
    );
  }

  // Delete the row.
  const { error: delErr } = await supabase
    .from("employee_rate_history")
    .delete()
    .eq("id", id);
  if (delErr) {
    return NextResponse.json({ success: false, error: delErr.message }, { status: 500 });
  }

  // Re-sync the `employee_hourly_rates` cache to the now-most-recent history
  // row whose effective_from <= today. The cache must reflect "rate as of
  // today" so existing read paths that don't yet consult history still get
  // the correct value.
  const todayIso = fmtIso(new Date());
  const { data: nowEffective, error: refetchErr } = await supabase
    .from("employee_rate_history")
    .select("regular_rate, ot_rate, effective_from")
    .eq("employee_email", row.employee_email)
    .lte("effective_from", todayIso)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (refetchErr) {
    // eslint-disable-next-line no-console
    console.warn("[rate-history revoke] cache refetch failed:", refetchErr.message);
  } else if (nowEffective) {
    // Match by Work Email OR Personal Email — the rates row uses either as
    // the natural key. We don't know which, so try both with ilike.
    const cacheUpdate = {
      "Regular Rate": nowEffective.regular_rate,
      "OT Rate": nowEffective.ot_rate,
    };
    const { error: u1 } = await supabase
      .from(RATES_TABLE)
      .update(cacheUpdate)
      .ilike("Work Email", row.employee_email);
    if (u1) {
      // eslint-disable-next-line no-console
      console.warn("[rate-history revoke] cache update by work email failed:", u1.message);
    }
    // Update any rows keyed on Personal Email too (covers the case where the
    // user's rates row only has Personal Email set).
    await supabase
      .from(RATES_TABLE)
      .update(cacheUpdate)
      .ilike("Personal Email", row.employee_email);
    invalidateRateProfilesCache();
  }

  void insertAuditLog({
    user_name: authz.effectiveEmail,
    user_role: "admin",
    action: "employee.rates.revoke",
    resource: "employee_rate_history",
    resource_id: id,
    details: {
      employee: row.employee_email,
      revoked: {
        regular_rate: row.regular_rate,
        ot_rate: row.ot_rate,
        effective_from: row.effective_from,
      },
      resynced_cache_to: nowEffective
        ? { regular_rate: nowEffective.regular_rate, ot_rate: nowEffective.ot_rate, effective_from: nowEffective.effective_from }
        : null,
    },
    ip_address: clientIp(req),
  });

  return NextResponse.json({ success: true, resyncedCacheTo: nowEffective ?? null });
}
