import { NextResponse } from "next/server";
import { getDepartmentRateSummaries } from "@/lib/supabase/department-rates";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/hr/department-rates
 *
 * Powers the department drop-down on the HR "Add person" form. Returns the
 * mode of `regular_rate` and `ot_rate` from `employee_hourly_rates`, grouped
 * by department, so picking a department pre-fills typical compensation.
 */
export async function GET() {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);
  const { departments, error } = await getDepartmentRateSummaries();
  if (error) return NextResponse.json({ departments: [], error }, { status: 500 });
  return NextResponse.json({ departments });
}
