import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { normEmail } from '@/lib/email/norm-email';
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
  if (!roles.includes('admin')) {
    return NextResponse.json(
      { people: [], departments: [], error: 'Admin rights are required to initiate a transfer.' },
      { status: 403 },
    );
  }

  const { people: available, error } = await listActiveMasterListPeople();
  if (error) return NextResponse.json({ people: [], departments: [], error }, { status: 500 });

  // Initiation is admin-only, and admins are unrestricted — an admin can pull
  // ANYONE, including someone in a department they themselves also manage (a
  // manager-with-admin). So we deliberately do NOT exclude the caller's own
  // departments here (doing so hid people on teams the admin also manages).

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
    const work = (p.work_email ?? '').toLowerCase();
    const personal = (p.personal_email ?? '').toLowerCase();
    return (
      p.name.toLowerCase().includes(q) ||
      pDept.includes(q) ||
      work.includes(q) ||
      personal.includes(q)
    );
  });

  return NextResponse.json({ people: filtered.slice(0, 200), departments, error: null });
}
