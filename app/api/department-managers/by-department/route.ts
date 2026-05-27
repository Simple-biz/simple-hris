import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { listManagersByDepartment } from '@/lib/supabase/department-managers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/department-managers/by-department?department=X
 *
 * Returns the active manager emails for a single department. Readable by any
 * authenticated session (mirrors the team-list / team-wallpaper visibility) so
 * the employee "My Team" roster can surface its department's manager(s) even
 * when the manager's own profile department differs. Read-only — assigning and
 * revoking still goes through the admin-only `/api/department-managers`.
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const department = req.nextUrl.searchParams.get('department')?.trim();
  if (!department) return NextResponse.json({ emails: [] });

  const emails = await listManagersByDepartment(department);
  return NextResponse.json({ emails });
}
