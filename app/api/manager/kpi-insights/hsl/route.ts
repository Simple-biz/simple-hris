import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { hasElevatedRole } from '@/lib/auth/elevated-roles';
import { listDepartmentsForManager } from '@/lib/supabase/department-managers';
import { getBuiltinSubs } from '@/lib/departments/builtin-subs-db';
import { builtinSubsFor } from '@/lib/departments/builtin-subs';
import { HSL_BUILTIN_KEY } from '@/lib/departments/registry';
import { readHslInsightEntries, readInsightStatuses, readLatestSentWeek } from '@/lib/supabase/kpi-insights-db';
import {
  buildKpiInsights,
  isSundayIso,
  scopeHslInsightBranchKeys,
  trendWindow,
  type KpiInsightsResponse,
} from '@/lib/manager/kpi-insights';
import { manilaTodayIso, sundayOf } from '@/lib/payroll/manila-week';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/manager/kpi-insights/hsl?depts=a,b,c&week=YYYY-MM-DD
 *
 * The same three cards as `/api/manager/kpi-insights`, above Manager → KPI
 * Calculator → **HSL Branches**: the branch spotlight, the week's top earner and
 * the weekly total sent to Accounting. Read-only. Doc:
 * `docs/features/kpi-calculator-insights.md` § HSL Branches.
 *
 * ## The gate is the HSL calculator's own
 *
 * Manager / admin / elevated roles only, as on the Departments route. Scope is
 * narrower: that calculator shows a branch only on an explicit `hsl:<key>` grant
 * in `department_managers` — being elevated does not unlock it — so neither does
 * this. `depts` proves nothing: each key is re-matched against the session's own
 * grants and against the branches that exist right now (the code teams that
 * score, plus the data sub-teams stored under HSL), and an out-of-scope key is
 * dropped, not an error. The sub-team list is read strictly: a failed read is a
 * 500, never "no data branches", because a branch silently missing from the
 * total would draw a dip nobody paid.
 *
 * The money is `hsl_bonus_entries.calculated_bonus` — every row's bonus is on the
 * calculator grid already, so this aggregates what those managers can see.
 */
export async function GET(req: NextRequest) {
  const empty = (error: string | null, status = 200) =>
    NextResponse.json({ depts: [], through: null, insights: null, error } satisfies KpiInsightsResponse, {
      status,
    });

  const session = await getServerSession(authOptions);
  const user = session?.user as { email?: string | null; roles?: string[] } | undefined;
  const sessionEmail = (user?.email ?? '').trim().toLowerCase();
  if (!sessionEmail) return empty('Not signed in', 401);

  const roles = (user?.roles ?? []) as string[];
  if (!(roles.includes('manager') || roles.includes('admin') || hasElevatedRole(roles))) {
    return empty('Manager or admin role required', 403);
  }

  const week = req.nextUrl.searchParams.get('week')?.trim() ?? '';
  // Every stored KPI week is keyed on a Sunday; a Monday-anchored guess would
  // read a (branch, week) pair no row is ever filed under and show an empty card.
  if (!isSundayIso(week)) return empty('week must be a Sunday (YYYY-MM-DD)', 400);

  const requested = (req.nextUrl.searchParams.get('depts') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const { rows: assigns, error: dmErr } = await listDepartmentsForManager(sessionEmail);
  if (dmErr) return empty(dmErr, 500);
  const managed = assigns.map((a) => a.department.trim()).filter(Boolean);

  let dataBranchKeys: string[];
  try {
    dataBranchKeys = builtinSubsFor(await getBuiltinSubs(), HSL_BUILTIN_KEY).map((s) => s.key);
  } catch (e) {
    return empty(e instanceof Error ? e.message : 'Could not read the HSL sub-teams', 500);
  }
  const depts = scopeHslInsightBranchKeys(requested, managed, dataBranchKeys);
  if (depts.length === 0) return empty(null);

  const latest = await readLatestSentWeek(depts, sundayOf(manilaTodayIso()));
  if (latest.error) return empty(latest.error, 500);
  const through = latest.week ? sundayOf(latest.week) : null;
  const weeks = through ? trendWindow(through) : [];
  const readWeeks = Array.from(new Set([...weeks, week]));

  const [statuses, entries] = await Promise.all([
    readInsightStatuses(depts, readWeeks),
    readHslInsightEntries(depts, readWeeks),
  ]);
  const readError = statuses.error ?? entries.error;
  if (readError) return empty(readError, 500);

  const insights = buildKpiInsights({
    weeks,
    depts,
    selectedWeek: week,
    applied: entries.rows,
    statuses: statuses.rows,
  });
  return NextResponse.json({ depts, through, insights, error: null } satisfies KpiInsightsResponse);
}
