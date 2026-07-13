import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { hasElevatedRole, hasRateVisibility } from '@/lib/auth/elevated-roles';
import { listDepartmentsForManager } from '@/lib/supabase/department-managers';
import {
  isRecentManualOnboard,
  listHrPendingEmployees,
  listManagerPendingHires,
  type HrPendingEmployeeRow,
} from '@/lib/supabase/hr-pending-employees';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function normEmail(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/**
 * GET — feeds the Manager Dashboard → My Team → Newly Hired tab. Returns every
 * actionable pending hire (`pending_work_email` or `ready` status) in any of
 * the viewer's managed departments, plus recently promoted Bypass rows so
 * manually onboarded people appear in the week they were onboarded (see
 * isRecentManualOnboard). Elevated viewers (HR / admin) see all.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  const user = session?.user as { email?: string | null; roles?: string[] } | undefined;
  const sessionEmail = normEmail(user?.email ?? null);
  if (!sessionEmail) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const roles = (user?.roles ?? []) as string[];
  if (!(roles.includes('manager') || roles.includes('admin'))) {
    return NextResponse.json({ error: 'Manager or admin role required' }, { status: 403 });
  }

  // Pay rates are Accounting/CEO only. Both managers (department branch) and HR
  // (the elevated branch below) consume this Newly-Hired list but must never
  // receive the staged hire's regular_rate/ot_rate — neither surface renders
  // them. Strip the figures for any caller without full rate visibility.
  const rateVisible = hasRateVisibility(roles);
  const stripRates = (rows: HrPendingEmployeeRow[] | null | undefined): HrPendingEmployeeRow[] =>
    rateVisible
      ? (rows ?? [])
      : (rows ?? []).map((r) => ({ ...r, regular_rate: null, ot_rate: null }));

  // Elevated viewers (HR / admin) bypass the department gate so they can audit
  // the same list. Keep the response shape identical to the scoped path.
  if (hasElevatedRole(roles)) {
    const { rows, error } = await listHrPendingEmployees();
    const actionable = rows.filter(
      (r) =>
        r.status === 'pending_work_email' ||
        r.status === 'ready' ||
        isRecentManualOnboard(r),
    );
    return NextResponse.json(
      { rows: stripRates(actionable), scope: 'elevated', departments: [], error },
      { status: error ? 500 : 200 },
    );
  }

  const { rows: assigns, error: dmErr } = await listDepartmentsForManager(sessionEmail);
  if (dmErr) {
    return NextResponse.json(
      { rows: [], scope: 'department', departments: [], error: dmErr },
      { status: 500 },
    );
  }
  const departments = assigns.map((a) => a.department.trim()).filter(Boolean);

  const { rows, error } = await listManagerPendingHires(departments);
  return NextResponse.json(
    { rows: stripRates(rows), scope: 'department', departments, error },
    { status: error ? 500 : 200 },
  );
}
