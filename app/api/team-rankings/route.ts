import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { hasElevatedRole } from '@/lib/auth/elevated-roles';
import { getTeamRankings } from '@/lib/supabase/team-rankings';
import { canViewTeamRankings } from '@/lib/rbac/rankings-viewers';
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
 * ## Two gates, in this order
 *
 * 1. **Viewer allow-list** — `canViewTeamRankings` (Kane, 2026-08-29). Everyone
 *    not on it reads an empty list for EVERY department, elevated roles included.
 *    This is why the route no longer mirrors /api/team-roster, which it used to
 *    match exactly; see `src/lib/rbac/rankings-viewers.ts` for why admins are not
 *    an exception. It runs before the department work so a denied caller costs no
 *    query.
 * 2. **Department scoping**, unchanged, and still identical to /api/team-roster:
 *    elevated roles may view any department; everyone else is limited to their own
 *    home department plus any department they manage. An arbitrary `?department=`
 *    therefore can't dump another team's scores, and an empty value can't dump the
 *    company.
 *
 * Both degrade to an empty list rather than 403 so the tab renders cleanly — the
 * client drops the Rankings pill when no weeks come back, so a denied viewer sees
 * the same thing as a team that was never scored, not an error.
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

  // Gate 1. Above the elevated-role bypass on purpose — an admin session is not an
  // exception here. Same empty shape as an out-of-scope department, so the tab just
  // loses its pill instead of surfacing "you are not allowed to see this".
  if (!canViewTeamRankings(sessionEmail)) {
    return NextResponse.json({ weeks: [], error: null });
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
