import { NextResponse } from "next/server";
import {
  listHrNewHireChecklistByDepartment,
  listHrNewHireChecklistDepartments,
} from "@/lib/supabase/hr-new-hire-checklist";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/hr/new-hire-checklist/departments
 *   → { departments: [{ department, count }] }   (Bulk Invite picker)
 *
 * GET /api/hr/new-hire-checklist/departments?department=Lead%20Gen
 *   → { rows: HrNewHireChecklistRow[] }           (rows for that department)
 *
 * Optional &period=YYYY-MM-DD (a Sun-anchored week start) scopes the rows to
 * that single week — Bulk Invite passes next week's Sunday so it only loads the
 * upcoming start cohort. Omitted = every week.
 */
export async function GET(req: Request) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const params = new URL(req.url).searchParams;
  const dept = params.get("department")?.trim();
  const period = params.get("period")?.trim() || null;
  if (dept) {
    const { rows, error } = await listHrNewHireChecklistByDepartment(dept, period);
    if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
    return NextResponse.json({ rows });
  }

  const { departments, error } = await listHrNewHireChecklistDepartments();
  if (error) return NextResponse.json({ departments: [], error }, { status: 500 });
  return NextResponse.json({ departments });
}
