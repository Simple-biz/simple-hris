import { NextRequest, NextResponse } from 'next/server';
import { authorizeManagedDepartment } from '@/lib/manager/managed-department-gate';
import { getDeliverableDailyRankings, getDeliverableRankings } from '@/lib/supabase/deliverable-rankings';
import { getHslKpiDailyRankings, getHslKpiRankings } from '@/lib/supabase/hsl-kpi-rankings';
import { hslBranchFromRailKey } from '@/lib/manager/deliverable-rankings';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { slugifyDeptKey } from '@/lib/departments/registry';
import { manilaTodayIso, sundayOf } from '@/lib/payroll/manila-week';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/manager/deliverable-rankings?department=<raw roster label>[&basis=daily]
 *
 * The KPI Rankings leaderboard — PM Team and every other department on a per-person
 * KPI bonus that has no Rankings view of its own. The default call returns every week of the
 * department's KPI item COUNTS, badged, plus the weekly/monthly order by BONUS EARNED
 * as positions only. `basis=daily` returns Hubstaff days worked plus the per-day order
 * (the slow read, fetched in the background). Kane, 2026-09-26: *"based on their Bonus
 * … without displaying it"* — the pesos are read and ranked server-side and never
 * returned (see `src/lib/supabase/deliverable-rankings.ts`). Doc:
 * `docs/features/manager-pm-rankings.md`.
 *
 * ## The gate is My Team's own — NOT the SP Rankings doors
 *
 * `authorizeManagedDepartment`, the same helper Lead Gen's Appointments and Rankings
 * reads call (Kane, 2026-09-26: *"The my team tab lets you only see what Departments
 * were assigned to you"*). Assignments scope even an elevated caller; only an
 * elevated caller with none reads any department. The department is re-checked on
 * every call; the rail choosing it proves nothing.
 *
 * An out-of-scope department degrades to `available: false` rather than 403, so the
 * leaderboard simply does not appear — the same as a department with no KPI item.
 * The route takes no email parameter; the roster it ranks is resolved server-side from
 * the department just authorized.
 *
 * ## HSL sub-teams (2026-09-28)
 *
 * `department=hsl:<key>` (the RAIL key — the display label "HSL — …" normalizes to no
 * department) reads that branch's KPI Calculator scores instead
 * (`src/lib/supabase/hsl-kpi-rankings.ts`, `docs/features/manager-hsl-kpi-rankings.md`),
 * behind the SAME gate, ranked on the stored `calculated_bonus`, All bonuses only.
 */
export async function GET(req: NextRequest) {
  const department = req.nextUrl.searchParams.get('department')?.trim() ?? '';
  const daily = req.nextUrl.searchParams.get('basis') === 'daily';
  const empty = daily
    ? { days: [], order: null }
    : {
        available: false,
        currentWeekStart: sundayOf(manilaTodayIso()),
        weeks: [],
        metrics: [],
        skippedRows: 0,
        order: null,
      };

  const gate = await authorizeManagedDepartment(department);
  if (gate.kind === 'unauthenticated') return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (gate.kind === 'forbidden') {
    return NextResponse.json({ error: 'Manager or admin role required' }, { status: 403 });
  }
  if (gate.kind === 'error') return NextResponse.json({ ...empty, error: gate.error }, { status: 500 });
  if (gate.kind === 'out_of_scope') return NextResponse.json({ ...empty, error: null });

  const hslBranch = hslBranchFromRailKey(department);
  if (hslBranch) {
    const hsl = daily
      ? await getHslKpiDailyRankings(department, hslBranch)
      : await getHslKpiRankings(department, hslBranch);
    return NextResponse.json(hsl, { status: hsl.error ? 500 : 200 });
  }

  // Built-in payroll key first ("PM Team" -> "pm_team"); otherwise the slug an in-app
  // registry department is stored under — the same two steps every My Team ranking uses.
  const deptKey = normalizeDeptToKey(department) ?? slugifyDeptKey(department);
  const payload = daily
    ? await getDeliverableDailyRankings(deptKey, department)
    : await getDeliverableRankings(deptKey, department);
  return NextResponse.json(payload, { status: payload.error ? 500 : 200 });
}
