import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { hasElevatedRole } from '@/lib/auth/elevated-roles';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/hsl-bonus/team-members              -> all rows (manager/elevated)
// GET /api/hsl-bonus/team-members?dept=KEY     -> filtered by dept_key
//
// Consumers: the manager HSL KPI Calculator and the accounting Payroll Wizard.
// SECURITY: this used to run on the service-role client with NO auth gate, so
// any authenticated employee could read the HSL roster — including the
// `hourly_rate`/`ot_rate` columns, which neither consumer renders. The rate
// columns are dropped from the SELECT (pay rates are Accounting/CEO only) and
// the read is gated to managers + elevated (accounting/admin) sessions.
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const user = session?.user as { email?: string | null; roles?: string[] } | undefined;
  if (!user?.email) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }
  const roles = (user.roles ?? []) as string[];
  if (!roles.includes('manager') && !hasElevatedRole(roles)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const dept = searchParams.get('dept');

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
  }

  let query = supabase
    .from('hsl_team_members')
    .select('email, full_name, hsl_name, role_raw, dept_key, sub_team, is_manager')
    .order('full_name');

  if (dept) query = query.eq('dept_key', dept);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}
