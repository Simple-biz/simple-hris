import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { hasElevatedRole } from '@/lib/auth/elevated-roles';
import { listDepartmentsForManager } from '@/lib/supabase/department-managers';
import { readInsightApplied, readInsightStatuses, readLatestSentWeek } from '@/lib/supabase/kpi-insights-db';
import {
  buildKpiInsights,
  isSundayIso,
  scopeInsightDeptKeys,
  trendWindow,
  type InsightScope,
  type KpiInsightsResponse,
} from '@/lib/manager/kpi-insights';
import { manilaTodayIso, sundayOf } from '@/lib/payroll/manila-week';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/manager/kpi-insights?depts=a,b,c&week=YYYY-MM-DD
 *
 * The three cards above the Manager → KPI Calculator → Departments grid: the
 * department spotlight (average bonus per week sent), the top earner for `week`,
 * and the weekly total sent to Accounting. Read-only. Doc:
 * `docs/features/kpi-calculator-insights.md`.
 *
 * ## The gate is the one the grid already sits on
 *
 * Role and scope are resolved exactly as `/api/manager/department-members`
 * resolves them — the roster the calculator's department list is derived from:
 * manager / admin / elevated roles only; a caller WITH `department_managers` rows
 * is scoped to them even when elevated; only an elevated caller with none reads
 * every calculator department. `depts` is the client's grid and proves nothing —
 * each key is re-matched against the session's own assignments
 * (`scopeInsightDeptKeys`), and an out-of-scope key is dropped, not an error.
 *
 * The same managers already see each of these figures on this page (the per-dept
 * projection, every row's bonus), any past week through the week picker.
 * This route aggregates them; it reveals nothing the grid does not.
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
  const elevated = hasElevatedRole(roles);
  if (!(roles.includes('manager') || roles.includes('admin') || elevated)) {
    return empty('Manager or admin role required', 403);
  }

  const week = req.nextUrl.searchParams.get('week')?.trim() ?? '';
  // Every stored KPI week is keyed on a Sunday; a Monday-anchored guess would
  // read a (dept, week) pair no row is ever filed under and show an empty card.
  if (!isSundayIso(week)) return empty('week must be a Sunday (YYYY-MM-DD)', 400);

  const requested = (req.nextUrl.searchParams.get('depts') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const { rows: assigns, error: dmErr } = await listDepartmentsForManager(sessionEmail);
  if (dmErr) return empty(dmErr, 500);
  const managed = assigns.map((a) => a.department.trim()).filter(Boolean);
  const scope: InsightScope =
    managed.length > 0 ? { kind: 'department', managed } : elevated ? { kind: 'elevated' } : { kind: 'department', managed: [] };
  const depts = scopeInsightDeptKeys(requested, scope);
  if (depts.length === 0) return empty(null);

  const latest = await readLatestSentWeek(depts, sundayOf(manilaTodayIso()));
  if (latest.error) return empty(latest.error, 500);
  const through = latest.week ? sundayOf(latest.week) : null;
  const weeks = through ? trendWindow(through) : [];
  const readWeeks = Array.from(new Set([...weeks, week]));

  const [statuses, applied] = await Promise.all([
    readInsightStatuses(depts, readWeeks),
    readInsightApplied(depts, readWeeks),
  ]);
  const readError = statuses.error ?? applied.error;
  if (readError) return empty(readError, 500);

  const insights = buildKpiInsights({
    weeks,
    depts,
    selectedWeek: week,
    applied: applied.rows,
    statuses: statuses.rows,
  });
  return NextResponse.json({ depts, through, insights, error: null } satisfies KpiInsightsResponse);
}
