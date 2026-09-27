import { NextRequest, NextResponse } from 'next/server';
import { authorizeManagedDepartment } from '@/lib/manager/managed-department-gate';
import { getDepartmentDaysWorked } from '@/lib/supabase/appointment-days';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/manager/appointment-rankings/days?department=<raw roster label>
 *
 * Hubstaff days worked per person-week for the department's roster — the
 * denominator of the Rankings leaderboard's daily average. Returns emails, weeks
 * and day COUNTS only: no hours, no money. Doc:
 * `docs/features/manager-appointment-leaderboard.md`.
 *
 * Same gate as the Appointments read (`authorizeManagedDepartment`). Days worked
 * is attendance, which managers already see on My Team (`manager-my-team.md:15-17`).
 * The roster whose days are returned is resolved SERVER-side from the department
 * just authorized; this route takes no email parameter.
 */
export async function GET(req: NextRequest) {
  const department = req.nextUrl.searchParams.get('department')?.trim() ?? '';

  const gate = await authorizeManagedDepartment(department);
  if (gate.kind === 'unauthenticated') return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (gate.kind === 'forbidden') {
    return NextResponse.json({ error: 'Manager or admin role required' }, { status: 403 });
  }
  if (gate.kind === 'error') return NextResponse.json({ days: [], error: gate.error }, { status: 500 });
  if (gate.kind === 'out_of_scope') return NextResponse.json({ days: [], error: null });

  const payload = await getDepartmentDaysWorked(department);
  return NextResponse.json(payload, { status: payload.error ? 500 : 200 });
}
