import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { getTeamRoster } from '@/lib/supabase/team-roster';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/team-roster?department=X
 *
 * Lightweight roster for the employee "My Team" page. Returns the same-department
 * profiles + the department's manager(s), plus their skill sets and last-seen
 * timestamps in a single roundtrip. Bypasses the heavy rates/master/employee_ids
 * merge that powers /api/employee-rate-profiles/summary.
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const department = req.nextUrl.searchParams.get('department')?.trim() ?? '';
  const result = await getTeamRoster(department || null);
  return NextResponse.json(result);
}
