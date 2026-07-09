import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { normEmail } from '@/lib/email/norm-email';
import { listDepartmentsForManager } from '@/lib/supabase/department-managers';
import { listActiveMasterListPeople } from '@/lib/supabase/global-master-list-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type SessionLike = { user?: { email?: string | null; roles?: string[] } | null } | null;
function rolesOf(session: SessionLike): string[] {
  return (session?.user?.roles ?? []) as string[];
}

/**
 * GET — transfer-target candidates for the "Request transfer in" picker.
 *
 * Active Global-Master-List people the requesting manager could pull into a
 * department they manage: everyone EXCEPT those already in one of the manager's
 * own departments. Returns Name + Department + emails only — NO pay/rate data
 * (managers never see pay). Optional `?q=` filters on name/department.
 */
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  const sessionEmail = normEmail(session?.user?.email ?? '') ?? '';
  if (!sessionEmail) return NextResponse.json({ people: [], error: 'Not signed in' }, { status: 401 });

  const roles = rolesOf(session);
  const isManager = roles.includes('manager');
  const isAdmin = roles.includes('admin');
  if (!isManager && !isAdmin) {
    return NextResponse.json({ people: [], error: 'Manager or admin role required' }, { status: 403 });
  }

  const { people, error } = await listActiveMasterListPeople();
  if (error) return NextResponse.json({ people: [], departments: [], error }, { status: 500 });

  // Exclude the manager's own departments — you can't "pull in" someone already
  // on your team. Admins have no assignments, so they see everyone.
  const { rows: assigns } = await listDepartmentsForManager(sessionEmail);
  const ownDepts = new Set(assigns.map((a) => a.department.trim().toLowerCase()).filter(Boolean));

  // Everyone the manager could pull in, before search/department narrowing.
  const available = people.filter((p) => {
    const dept = (p.department ?? '').trim().toLowerCase();
    return !(ownDepts.size > 0 && dept && ownDepts.has(dept));
  });

  // Full department list for the picker's filter dropdown — computed from the
  // available set so it stays stable regardless of the active filters.
  const departments = Array.from(
    new Set(available.map((p) => (p.department ?? '').trim()).filter(Boolean)),
  ).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  const params = new URL(request.url).searchParams;
  const q = params.get('q')?.trim().toLowerCase() ?? '';
  const dept = params.get('department')?.trim().toLowerCase() ?? '';

  const filtered = available.filter((p) => {
    const pDept = (p.department ?? '').trim().toLowerCase();
    if (dept && pDept !== dept) return false;
    if (!q) return true;
    return p.name.toLowerCase().includes(q) || pDept.includes(q);
  });

  return NextResponse.json({ people: filtered.slice(0, 200), departments, error: null });
}
