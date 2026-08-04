import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { hasElevatedRole } from '@/lib/auth/elevated-roles';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { listActiveMasterListPeople, type ActiveMasterListPerson } from '@/lib/supabase/global-master-list-db';
import { mergeHslRoster } from '@/lib/hsl-bonus/roster-merge';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Short in-memory cache for the GML active-roster read: this route is polled
// every ~30s per visible branch by the KPI Calculator's live-refresh
// (useLiveRefresh), and an elevated session loads all 14 branches on boot —
// without this, each poll would re-run a full paginated active_employees scan
// per branch. Same TTL-cache shape as invalidateRateProfilesCache in
// employee-rate-profiles.ts. Scoped to this route only (not shared with
// listActiveMasterListPeople's other callers, e.g. the transfer picker, which
// may want fresher reads).
const GML_CACHE_TTL_MS = 30_000;
let cachedGmlPeople: { ts: number; people: ActiveMasterListPerson[] } | null = null;

async function getActiveMasterListPeopleCached(): Promise<ActiveMasterListPerson[]> {
  if (cachedGmlPeople && Date.now() - cachedGmlPeople.ts < GML_CACHE_TTL_MS) {
    return cachedGmlPeople.people;
  }
  const { people, error } = await listActiveMasterListPeople();
  if (error) {
    console.error('[hsl-bonus/team-members] listActiveMasterListPeople failed:', error);
    return cachedGmlPeople?.people ?? [];
  }
  cachedGmlPeople = { ts: Date.now(), people };
  return people;
}

// GET /api/hsl-bonus/team-members              -> all rows (manager/elevated)
// GET /api/hsl-bonus/team-members?dept=KEY     -> filtered by dept_key
//
// Consumers: the manager HSL KPI Calculator and the accounting Payroll Wizard.
// Rows come from TWO sources, merged by lower-cased email (see mergeHslRoster
// in src/lib/hsl-bonus/roster-merge.ts):
//   1. hsl_team_members — the Hogan Smith Law sheet-synced roster (manually
//      dept_key-classified). Wins on conflict for is_manager/sub_team/dept_key
//      (when it has one).
//   2. global_master_list — active people whose Department resolves to an HSL
//      branch via matchHslSubDeptKey (the namespaced `hsl:<key>` tag written
//      by Department Transfers, or the branch's plain display name). Lets
//      someone onboarded through the HR Pipeline appear without waiting on a
//      Hogan sheet sync. See docs/superpowers/specs/2026-08-03-hsl-kpi-gml-roster-design.md.
//
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

  const gmlPeople = await getActiveMasterListPeopleCached();
  const rows = mergeHslRoster(data ?? [], gmlPeople, dept);
  return NextResponse.json({ rows });
}
