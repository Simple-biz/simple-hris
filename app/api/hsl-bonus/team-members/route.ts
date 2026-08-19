import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { hasElevatedRole } from '@/lib/auth/elevated-roles';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { listActiveMasterListPeople, type ActiveMasterListPerson } from '@/lib/supabase/global-master-list-db';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { mergeHslRoster, type HslRosterRow } from '@/lib/hsl-bonus/roster-merge';

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
//
// Caches the in-flight PROMISE while a fetch is underway, not just the
// resolved value: the KPI Calculator boots by fetching every visible branch
// concurrently (Promise.all over up to 14 branches for an elevated session)
// and repeats that on every live-refresh poll, so on every cache-cold cycle
// all ~14 concurrent requests would otherwise each independently call
// listActiveMasterListPeople() (a full paginated active-roster scan) — the
// exact thundering herd this cache exists to prevent. Concurrent callers
// during a miss window now all await the SAME in-progress fetch instead of
// each starting their own.
const GML_CACHE_TTL_MS = 30_000;
let cachedGmlPeople: { ts: number; people: ActiveMasterListPerson[] } | null = null;
let inflightGmlFetch: Promise<ActiveMasterListPerson[]> | null = null;

async function getActiveMasterListPeopleCached(): Promise<ActiveMasterListPerson[]> {
  if (cachedGmlPeople && Date.now() - cachedGmlPeople.ts < GML_CACHE_TTL_MS) {
    return cachedGmlPeople.people;
  }
  if (inflightGmlFetch) return inflightGmlFetch;
  inflightGmlFetch = (async () => {
    const { people, error } = await listActiveMasterListPeople();
    if (error) {
      console.error('[hsl-bonus/team-members] listActiveMasterListPeople failed:', error);
      return cachedGmlPeople?.people ?? [];
    }
    cachedGmlPeople = { ts: Date.now(), people };
    return people;
  })();
  try {
    return await inflightGmlFetch;
  } finally {
    inflightGmlFetch = null;
  }
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
// The `?dept=` filter is applied to the MERGED result inside mergeHslRoster,
// not as a narrowing `.eq('dept_key', dept)` on the hsl_team_members SQL
// query — an hsl_team_members row can be unclassified (dept_key: null) but
// still resolve a specific branch via its GML counterpart, and pre-filtering
// the SQL query would silently drop that row (and its sheet metadata: is_manager/
// sub_team/hsl_name/role_raw) before the merge ever saw it. So hsl_team_members
// is read in FULL every time, paginated past PostgREST's 1000-row cap via
// selectAllPaged (566 rows today; will cross 1000 eventually).
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

  const { rows: hslRows, error } = await selectAllPaged<HslRosterRow>((from, to) =>
    supabase
      .from('hsl_team_members')
      .select('email, full_name, hsl_name, role_raw, dept_key, sub_team, is_manager')
      .order('email', { ascending: true })
      .range(from, to),
  );
  if (error) return NextResponse.json({ error }, { status: 500 });

  const gmlPeople = await getActiveMasterListPeopleCached();
  const rows = mergeHslRoster(hslRows, gmlPeople, dept);
  return NextResponse.json({ rows });
}
