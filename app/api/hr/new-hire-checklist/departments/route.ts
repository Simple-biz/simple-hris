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
 */
export async function GET(req: Request) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const dept = new URL(req.url).searchParams.get("department")?.trim();
  if (dept) {
    const { rows, error } = await listHrNewHireChecklistByDepartment(dept);
    if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
    return NextResponse.json({ rows });
  }

  const { departments, error } = await listHrNewHireChecklistDepartments();
  if (error) return NextResponse.json({ departments: [], error }, { status: 500 });
  return NextResponse.json({ departments });
}
