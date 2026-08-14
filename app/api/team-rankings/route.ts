import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { hasElevatedRole } from '@/lib/auth/elevated-roles';
import { getTeamRankings } from '@/lib/supabase/team-rankings';
import { getEmployeeMasterRecord } from '@/lib/supabase/employees';
import { listDepartmentsForManager } from '@/lib/supabase/department-managers';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { slugifyDeptKey } from '@/lib/departments/registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/team-rankings?department=X
 *
 * Weekly SP rankings for the employee "My Team → Rankings" tab. Returns SP, the
 * ranking tier, and a derived position — never a peso amount (see
 * `src/lib/supabase/team-rankings.ts`). Weeks appear only once the manager marks
 * them ready/locked.
 *
 * Scoping is deliberately IDENTICAL to /api/team-roster: elevated roles
 * (admin/payroll/finance/hr/viewer) may view any department; everyone else is
 * limited to their own home department plus any department they manage. An
 * arbitrary `?department=` therefore can't dump another team's scores, and an
 * empty value can't dump the company. Out-of-scope requests degrade to an empty
 * list rather than 403 so the tab renders cleanly.
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const user = session?.user as
    | { email?: string | null; roles?: string[]; elevated?: boolean }
    | undefined;
  const sessionEmail = (user?.email ?? '').trim().toLowerCase();
  if (!sessionEmail) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const department = req.nextUrl.searchParams.get('department')?.trim() ?? '';
  const roles = user?.roles ?? [];
  const elevated = user?.elevated ?? hasElevatedRole(roles);

  if (!elevated) {
    const [{ employee }, { rows: managed }] = await Promise.all([
      getEmployeeMasterRecord(sessionEmail),
      listDepartmentsForManager(sessionEmail),
    ]);
    const allowed = new Set<string>();
    const own = employee?.department?.trim().toLowerCase();
    if (own) allowed.add(own);
    for (const m of managed) {
      const d = m.department?.trim().toLowerCase();
      if (d) allowed.add(d);
    }
    const reqNorm = department.toLowerCase();
    if (!reqNorm || !allowed.has(reqNorm)) {
      return NextResponse.json({ weeks: [], error: null });
    }
  }

  if (!department) return NextResponse.json({ weeks: [], error: null });

  // Built-in payroll key first ("AI/API Team" -> "devs"); otherwise the slug an
  // in-app registry department is stored under. Same two-step the KPI Calculator
  // uses to derive its cards.
  const deptKey = normalizeDeptToKey(department) ?? slugifyDeptKey(department);
  const result = await getTeamRankings(deptKey);
  return NextResponse.json(result);
}
