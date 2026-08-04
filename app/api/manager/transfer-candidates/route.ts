import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { normEmail } from '@/lib/email/norm-email';
import { listDepartmentsForManager } from '@/lib/supabase/department-managers';
import { listActiveMasterListPeople } from '@/lib/supabase/global-master-list-db';
import { listRecentlyOffboardedPeople } from '@/lib/roster/recently-offboarded';

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
  const isAdmin = roles.includes('admin');
  const isManager = roles.includes('manager');
  if (!isAdmin && !isManager) {
    return NextResponse.json(
      { people: [], departments: [], error: 'Manager or admin role required' },
      { status: 403 },
    );
  }

  // `?offboarded=1` — the KPI calculators' "Offboarded" picker group: people
  // who recently left (pipeline offboard, offboarded sheet, or fell off the
  // roster) whose FINAL bonuses may still need scoring. Same shape as the
  // active candidates plus off_boarded_at + hubstaff_email (the identity
  // payroll actually pays — see src/lib/roster/recently-offboarded.ts) +
  // last_hours_week_start. The list is a recent-departures SUPERSET: each
  // calculator scopes it to the pay week it's viewing (only people whose
  // final pay cycle is that week — src/lib/roster/offboarded-week-relevance.ts),
  // so someone who left two-plus weeks ago no longer clutters the strips. The
  // transfer picker never sends this flag, so transfers keep offering only
  // active people. No dept exclusion here: these people have left their dept
  // by definition, and managers add them precisely to score their own team's
  // final week.
  // `off_boarded_reason` is deliberately STRIPPED before returning: raw HR
  // termination reasons (performance, ncns, time_manipulation, …) are
  // payroll-only and must never reach a manager's browser.
  if (new URL(request.url).searchParams.get('offboarded') === '1') {
    const { people: offboardedRaw, hoursWeekFloor, error: offErr } = await listRecentlyOffboardedPeople();
    if (offErr) return NextResponse.json({ offboarded: [], error: offErr }, { status: 500 });
    const offboarded = offboardedRaw.map(({ off_boarded_reason: _reason, ...rest }) => rest);
    return NextResponse.json({ offboarded, hours_week_floor: hoursWeekFloor, error: null });
  }

  const { people, error } = await listActiveMasterListPeople();
  if (error) return NextResponse.json({ people: [], departments: [], error }, { status: 500 });

  // A non-admin manager may only pull people IN FROM other departments — never
  // from a department they themselves manage (that's their own team). Admins are
  // unrestricted (can pull anyone, incl. from a dept they also manage).
  let available = people;
  if (!isAdmin) {
    const { rows: assigns } = await listDepartmentsForManager(sessionEmail);
    const ownDepts = new Set(assigns.map((a) => a.department.trim().toLowerCase()).filter(Boolean));
    if (ownDepts.size > 0) {
      available = people.filter((p) => {
        const d = (p.department ?? '').trim().toLowerCase();
        return !(d && ownDepts.has(d));
      });
    }
  }

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
