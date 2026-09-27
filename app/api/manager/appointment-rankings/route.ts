import { NextRequest, NextResponse } from 'next/server';
import { authorizeManagedDepartment } from '@/lib/manager/managed-department-gate';
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
 * My Team → Appointments (and the Rankings leaderboard's weeks). Counts only,
 * never pesos (see `src/lib/supabase/appointment-rankings.ts`). Doc:
 * `docs/features/manager-appointment-rankings.md`.
 *
 * ## The gate is My Team's own — NOT the SP Rankings doors
 *
 * `authorizeManagedDepartment` (Kane, 2026-09-26: *"The my team tab lets you only
 * see what Departments were assigned to you"*) mirrors
 * `/api/manager/department-members`: assignments scope even an elevated caller;
 * only an elevated caller with none reads any department. The department is
 * re-checked on every call; the rail choosing it proves nothing.
 *
 * An out-of-scope department degrades to `available: false` rather than 403 — the
 * pill simply does not appear, the same as a department with no appointment
 * variable.
 */
export async function GET(req: NextRequest) {
  const department = req.nextUrl.searchParams.get('department')?.trim() ?? '';
  const empty = { available: false, currentWeekStart: sundayOf(manilaTodayIso()), weeks: [] };

  const gate = await authorizeManagedDepartment(department);
  if (gate.kind === 'unauthenticated') return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (gate.kind === 'forbidden') {
    return NextResponse.json({ error: 'Manager or admin role required' }, { status: 403 });
  }
  if (gate.kind === 'error') return NextResponse.json({ ...empty, error: gate.error }, { status: 500 });
  if (gate.kind === 'out_of_scope') return NextResponse.json({ ...empty, error: null });

  // Built-in payroll key first ("Lead Gen" -> "lead_gen"); otherwise the slug an
  // in-app registry department is stored under — the same two steps the KPI
  // Calculator and /api/team-rankings use.
  const deptKey = normalizeDeptToKey(department) ?? slugifyDeptKey(department);
  const payload = await getAppointmentRankings(deptKey);
  return NextResponse.json(payload, { status: payload.error ? 500 : 200 });
}
