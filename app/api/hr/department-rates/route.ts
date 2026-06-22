import { NextResponse } from "next/server";
import { getDepartmentRateSummaries } from "@/lib/supabase/department-rates";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/hr/department-rates
 *
 * Powers the "compensation ready" badge on the HR "Add person" / onboarding
 * form. Returns ONLY a per-department readiness flag — `ready` is true when an
 * authoritative Payment Catalog pay structure exists for the department.
 *
 * SECURITY: pay rates are Accounting/CEO only. This endpoint is gated by
 * `requireElevatedSession`, which also admits `hr_coordinator`, so it must NOT
 * ship the numeric `regular_rate`/`ot_rate`/`currency` figures — HR only needs
 * to know whether Accounting has set the rate. The server re-derives the actual
 * rate from the catalog at submit time (set-work-email); the HR client never
 * sees or sends a figure.
 */
export async function GET() {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);
  const { departments, error } = await getDepartmentRateSummaries();
  if (error) return NextResponse.json({ departments: [], error }, { status: 500 });
  const readiness = departments.map((d) => ({
    department: d.department,
    ready: d.source === "catalog",
  }));
  return NextResponse.json({ departments: readiness });
}
