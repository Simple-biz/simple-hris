import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { getEmployeesForAuthorizedServerRoute } from '@/lib/supabase/employees';
import { loadQcDepartedEmails } from '@/lib/qc/departed-members';
import { isQcPeriodStart, qcPeriodStartError } from '@/lib/qc/period';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET ?week=YYYY-MM-DD → `{ emails, degraded }`
 *
 * Active-roster people who had already LEFT before the pay week being scored.
 * The KPI calculator drops them from its member list.
 *
 * **Why this is a separate call and not a field on the roster payload.** The
 * answer is week-dependent — someone who left on 2026-07-20 belongs in June's
 * calculator and not September's — while the manager roster is fetched once and
 * cached (`MANAGER_CACHE_KEYS.teamRoster`). Baking a week into that cache would
 * make the filter silently wrong the moment the manager changed weeks. This
 * refetches per week and leaves the roster cache alone.
 *
 * All four guards from the shipped Payment Catalog precedent apply
 * (`hasDepartedBeforeWeek`), including the hours guard — someone with a row in
 * that week's timesheet is NEVER hidden, whatever the stamps say. That guard is
 * why this is a server call: the client cannot read a timesheet.
 *
 * Fails OPEN: an unreadable evidence or timesheet read returns an empty set and
 * a `degraded` message. Hiding a live person means their KPI bonus is never
 * scored and never paid.
 */
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as { email?: string | null; roles?: string[] } | undefined;
  const email = (user?.email ?? '').trim().toLowerCase();
  const roles = user?.roles ?? [];
  if (!email) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (!(roles.includes('qc') || roles.includes('manager') || roles.includes('admin'))) {
    return NextResponse.json({ error: 'QC, manager, or admin role required' }, { status: 403 });
  }

  const week = new URL(request.url).searchParams.get('week');
  // Same Sunday lock the QC period key carries: a Monday key here would answer
  // for a week that does not exist and quietly hide the wrong people.
  if (!isQcPeriodStart(week)) {
    return NextResponse.json({ error: qcPeriodStartError(week) }, { status: 400 });
  }

  try {
    const { employees } = await getEmployeesForAuthorizedServerRoute();
    const { emails, error } = await loadQcDepartedEmails(employees, week);
    return NextResponse.json({ emails: [...emails], degraded: error, error: null });
  } catch (e) {
    // Never 500 into the calculator over this: an empty set hides nobody, which
    // is the safe direction.
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ emails: [], degraded: msg, error: null });
  }
}
