import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { hasElevatedRole } from '@/lib/auth/elevated-roles';
import { listDepartmentsForManager } from '@/lib/supabase/department-managers';
import { departmentMatchesManagedAssignments } from '@/lib/managed-department-scope';
import { getAppointmentRankings } from '@/lib/supabase/appointment-rankings';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { slugifyDeptKey } from '@/lib/departments/registry';
import { manilaTodayIso, sundayOf } from '@/lib/payroll/manila-week';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/manager/appointment-rankings?department=<raw roster label>
 *
 * Every week of the department's appointment counts, badged, for Manager →
 * My Team → Appointments. Counts only, never pesos (see
 * `src/lib/supabase/appointment-rankings.ts`). Doc:
 * `docs/features/manager-appointment-rankings.md`.
 *
 * ## The gate is My Team's own — NOT the SP Rankings allow-list
 *
 * Kane, 2026-09-26: *"The my team tab lets you only see what Departments were
 * assigned to you."* So this mirrors `/api/manager/department-members` exactly:
 *
 * - manager / admin / elevated roles only;
 * - a caller WITH `department_managers` rows is scoped to them — even when they
 *   also hold an elevated role;
 * - only an elevated caller with NO assignments may read any department.
 *
 * It deliberately does not consult `canViewTeamRankings`: that one-name list
 * governs the SP Rankings view and stays as it is. The department is re-checked
 * here on every call; the rail choosing it proves nothing.
 *
 * An out-of-scope department degrades to `available: false` rather than 403 — the
 * pane's pill simply does not appear, the same as a department with no
 * appointment variable.
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const user = session?.user as { email?: string | null; roles?: string[] } | undefined;
  const sessionEmail = (user?.email ?? '').trim().toLowerCase();
  if (!sessionEmail) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const roles = (user?.roles ?? []) as string[];
  const elevated = hasElevatedRole(roles);
  if (!(roles.includes('manager') || roles.includes('admin') || elevated)) {
    return NextResponse.json({ error: 'Manager or admin role required' }, { status: 403 });
  }

  const department = req.nextUrl.searchParams.get('department')?.trim() ?? '';
  const denied = () =>
    NextResponse.json({
      available: false,
      currentWeekStart: sundayOf(manilaTodayIso()),
      weeks: [],
      error: null,
    });
  if (!department) return denied();

  const { rows: assigns, error: dmErr } = await listDepartmentsForManager(sessionEmail);
  if (dmErr) {
    return NextResponse.json(
      { available: false, currentWeekStart: sundayOf(manilaTodayIso()), weeks: [], error: dmErr },
      { status: 500 },
    );
  }
  const managed = assigns.map((a) => a.department.trim()).filter(Boolean);
  if (managed.length > 0) {
    if (!departmentMatchesManagedAssignments(department, managed)) return denied();
  } else if (!elevated) {
    return denied();
  }

  // Built-in payroll key first ("Lead Gen" -> "lead_gen"); otherwise the slug an
  // in-app registry department is stored under — the same two steps the KPI
  // Calculator and /api/team-rankings use.
  const deptKey = normalizeDeptToKey(department) ?? slugifyDeptKey(department);
  const payload = await getAppointmentRankings(deptKey);
  return NextResponse.json(payload, { status: payload.error ? 500 : 200 });
}
