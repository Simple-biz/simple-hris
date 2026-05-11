import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { hasElevatedRole } from '@/lib/auth/elevated-roles';
import { listDepartmentsForManager } from '@/lib/supabase/department-managers';
import type { EmployeeRow } from '@/lib/supabase/employees';
import { getEmployeesForAuthorizedServerRoute } from '@/lib/supabase/employees';
import { departmentMatchesManagedAssignments } from '@/lib/managed-department-scope';
import { fetchActiveHslDetailsByEmail } from '@/lib/supabase/hsl-agents';
import {
  getEmployeeHourlyRatesRows,
  indexHourlyRatesByEmail,
} from '@/lib/supabase/employee-hourly-rates';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function normEmail(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

function sortRows(a: EmployeeRow, b: EmployeeRow): number {
  const an = (a.name ?? '').trim();
  const bn = (b.name ?? '').trim();
  if (!an && bn) return 1;
  if (an && !bn) return -1;
  return an.localeCompare(bn, undefined, { sensitivity: 'base' });
}

function toNumber(v: string | null | undefined): number | null {
  if (v == null) return null;
  const cleaned = v.replace(/[^\d.\-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * GET — My Team roster from `active_employees`, scoped by explicit `department_managers` rows
 * whenever that list is non-empty (even when the viewer also holds an elevated role).
 *
 * `active_employees` is the same surface populated by Admin → CSV / “Sync from Google Sheet”
 * (`replaceGlobalMasterListFromCsvText` in `global-master-list-db.ts` → current
 * `master_list_uploads` row). Rows not stamped by that ingest stay out of the view.
 *
 * Full org roster applies only when the user has no department-manager assignments AND holds
 * an elevated role (viewer, payroll, admin, …).
 *
 * Otherwise: scoped by assignments, or empty if manager with no assignments.
 */
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    const user = session?.user as { email?: string | null; roles?: string[] } | undefined;
    const sessionEmail = normEmail(user?.email ?? null);
    if (!sessionEmail) {
      return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
    }

    const roles = (user?.roles ?? []) as string[];
    const dashboardOk = roles.includes('manager') || roles.includes('admin');
    if (!dashboardOk) {
      return NextResponse.json({ error: 'Manager or admin role required' }, { status: 403 });
    }

    const elevated = hasElevatedRole(roles);

    const { rows: assigns, error: dmErr } = await listDepartmentsForManager(sessionEmail);
    if (dmErr) {
      return NextResponse.json(
        { rows: [], scope: 'department' as const, departments: [] as string[], error: dmErr },
        { status: 500 },
      );
    }
    const departments = assigns.map((a) => a.department.trim()).filter(Boolean);

    const { employees, error } = await getEmployeesForAuthorizedServerRoute();
    if (error) {
      return NextResponse.json(
        {
          rows: [],
          scope: departments.length > 0 ? ('department' as const) : ('elevated' as const),
          departments,
          error,
        },
        { status: 500 },
      );
    }

    // Pull HSL-specific details plus general payroll rates. AI/API and most
    // non-HSL departments do not appear in `active_hsl_agents`, so their manager
    // rates come from `employee_hourly_rates` by email.
    const { byEmail: hslByEmail } = await fetchActiveHslDetailsByEmail();
    const { rows: rateRows } = await getEmployeeHourlyRatesRows();
    const ratesByEmail = indexHourlyRatesByEmail(rateRows);
    const decorateWithHsl = (row: EmployeeRow): EmployeeRow => {
      const w = normEmail(row.work_email ?? null);
      const p = normEmail(row.personal_email ?? null);
      const hit = (w && hslByEmail.get(w)) || (p && hslByEmail.get(p)) || null;
      const rateHit = (w && ratesByEmail.get(w)) || (p && ratesByEmail.get(p)) || null;
      return {
        ...row,
        hsl_role: hit?.role ?? null,
        hsl_hourly_rate: hit?.hourlyRate ?? null,
        hsl_ot_rate: hit?.otRate ?? null,
        regular_rate: toNumber(rateHit?.regular_rate),
        ot_rate: toNumber(rateHit?.ot_rate),
      };
    };

    if (departments.length > 0) {
      const rows = employees
        .filter((e) => departmentMatchesManagedAssignments(e.department, departments))
        .map(decorateWithHsl);
      rows.sort(sortRows);

      return NextResponse.json({
        rows,
        scope: 'department' as const,
        departments,
        error: null,
      });
    }

    if (!elevated) {
      return NextResponse.json({
        rows: [],
        scope: 'department' as const,
        departments: [] as string[],
        error: null,
      });
    }

    const rows = [...employees].map(decorateWithHsl).sort(sortRows);
    return NextResponse.json({
      rows,
      scope: 'elevated' as const,
      departments: [] as string[],
      error: null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { rows: [], scope: 'department' as const, departments: [] as string[], error: msg },
      { status: 500 },
    );
  }
}
