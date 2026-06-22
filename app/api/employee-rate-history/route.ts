import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { authorizeEmailAccess, deniedResponse } from "@/lib/auth/authorize-email";
import { hasRateVisibility } from "@/lib/auth/elevated-roles";
import { normEmail } from "@/lib/email/norm-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET ?email=... — returns the full rate history for the given email, sorted
 * desc by `effective_from`. Self-or-elevated auth (same gate as the rest of
 * the employee portal).
 *
 * The list is small (one row per rate change, baseline backfill = 1) so we
 * don't paginate. Client side uses this to drive per-day prorated pay in
 * `EmployeeMyHours` and any future surfaces that need rate-as-of-date.
 */
export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get("email")?.trim();
  if (!email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }

  const authz = await authorizeEmailAccess(email);
  if (!authz.ok) return deniedResponse(authz);

  // Pay rates are Accounting/CEO only. authorizeEmailAccess admits any elevated
  // role (incl. hr_coordinator) for cross-user reads — restrict reading ANOTHER
  // employee's rate history to full rate visibility. Self-view (own email) is
  // always allowed, so employees keep their own per-day prorated pay.
  const isSelf = authz.effectiveEmail.toLowerCase() === authz.sessionEmail.toLowerCase();
  if (!isSelf && !hasRateVisibility(authz.roles)) {
    return NextResponse.json({ rows: [], error: "Forbidden" }, { status: 403 });
  }

  const target = normEmail(authz.effectiveEmail) ?? authz.effectiveEmail.toLowerCase();

  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ rows: [] });

  const { data, error } = await supabase
    .from("employee_rate_history")
    .select("id, employee_email, regular_rate, ot_rate, effective_from, note, created_by, created_at")
    .eq("employee_email", target)
    .order("effective_from", { ascending: false });

  if (error) {
    return NextResponse.json({ rows: [], error: error.message }, { status: 500 });
  }
  return NextResponse.json({ rows: data ?? [] });
}
