import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { hasElevatedRole } from '@/lib/auth/elevated-roles';
import { getTeamRoster } from '@/lib/supabase/team-roster';
import { getEmployeeMasterRecord } from '@/lib/supabase/employees';
import { listDepartmentsForManager } from '@/lib/supabase/department-managers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/team-roster?department=X
 *
 * Lightweight roster for the employee "My Team" page. Returns the same-department
 * profiles + the department's manager(s), plus their skill sets and last-seen
 * timestamps in a single roundtrip. Bypasses the heavy rates/master/employee_ids
 * merge that powers /api/employee-rate-profiles/summary.
 *
 * Scoping: elevated roles (admin/payroll/finance/hr/viewer) may view any
 * department. Everyone else is limited to their own home department plus any
 * department they manage — so an arbitrary `?department=` can't dump another
 * team's roster, and an empty value can't dump the entire company.
 *
 * REDACTED BY DESIGN: the response carries a short display name (quoted go-by,
 * else first name) and the WORK email — never the legal name, never the
 * personal address. Carla's 2026-09-09 safety ruling, enforced in
 * `getTeamRoster` rather than in the component, because this route is reachable
 * directly and `route-access.ts` gates pages, not APIs.
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
      // Don't leak another team (or, on empty, the whole org). Degrade to an
      // empty roster rather than 403 so the UI renders cleanly for employees
      // with no/foreign department selection.
      return NextResponse.json({ profiles: [], skillSets: {}, lastSeen: {}, error: null });
    }
  }

  // The viewer's email resolves "this card is you" server-side — the client no
  // longer receives the personal address it used to match on.
  const result = await getTeamRoster(department || null, sessionEmail);
  return NextResponse.json(result);
}
