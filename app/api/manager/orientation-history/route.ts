import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { hasElevatedRole, hasRateVisibility } from '@/lib/auth/elevated-roles';
import { listDepartmentsForManager } from '@/lib/supabase/department-managers';
import {
  listOrientationHistory,
  type HrPendingEmployeeRow,
} from '@/lib/supabase/hr-pending-employees';
import { listChecklistWeeksByEmail } from '@/lib/supabase/hr-new-hire-checklist';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function normEmail(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/**
 * GET — the history behind Manager Dashboard → My Team → New Hire Check List's
 * weekly orientation-attendance summary and its PDF export.
 *
 * Deliberately a SECOND read alongside `/api/manager/pending-hires`, not a
 * widening of it. That route answers "what can this manager action now" and is
 * what the actionable card list renders; widening it would put 974 cards on
 * screen instead of 3. This route answers "who showed up and who didn't", which
 * needs the `promoted` hires (they attended) and the `no_show` hires (the whole
 * point) that the actionable read filters away.
 *
 * The response pairs each hire with the week HR filed them under in the New Hire
 * Checklist — `hr_new_hire_checklist.period_start`, joined on personal_email.
 * That join is the authoritative hiring week: a pending row carries no link back
 * to the checklist and its own `start_date` is null on 973 of 974 live rows.
 *
 * Gate mirrors `/api/manager/pending-hires` exactly: signed in → manager|admin →
 * elevated viewers see everything, everyone else is scoped to their
 * `department_managers` assignments.
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

  // Pay rates are Accounting/CEO only and a staged-hire row carries them. Strip
  // for anyone without full rate visibility — this surface renders none.
  const rateVisible = hasRateVisibility(roles);
  const stripRates = (rows: HrPendingEmployeeRow[]): HrPendingEmployeeRow[] =>
    rateVisible ? rows : rows.map((r) => ({ ...r, regular_rate: null, ot_rate: null }));

  const elevated = hasElevatedRole(roles);

  let departments: string[] = [];
  if (!elevated) {
    const { rows: assigns, error: dmErr } = await listDepartmentsForManager(sessionEmail);
    if (dmErr) {
      return NextResponse.json(
        { rows: [], checklistWeeks: {}, scope: 'department', departments: [], error: dmErr },
        { status: 500 },
      );
    }
    departments = assigns.map((a) => a.department.trim()).filter(Boolean);
    // A manager with no assignment sees nothing — never the whole company.
    if (departments.length === 0) {
      return NextResponse.json({
        rows: [],
        checklistWeeks: {},
        scope: 'department',
        departments: [],
        error: null,
      });
    }
  }

  const { rows, error } = await listOrientationHistory(elevated ? undefined : departments);
  if (error) {
    return NextResponse.json(
      {
        rows: [],
        checklistWeeks: {},
        scope: elevated ? 'elevated' : 'department',
        departments,
        error,
      },
      { status: 500 },
    );
  }

  // The checklist covers every department. Project it down to the emails of the
  // rows this caller is actually allowed to see: a Lead Gen manager must not
  // receive the personal email of every hire in the company.
  const { weeksByEmail, error: ckErr } = await listChecklistWeeksByEmail();
  const scopedEmails = new Set(rows.map((r) => normEmail(r.personal_email)).filter(Boolean));
  const checklistWeeks: Record<string, string[]> = {};
  for (const email of scopedEmails) {
    const w = weeksByEmail.get(email);
    if (w && w.length > 0) checklistWeeks[email] = w;
  }

  // A checklist failure is NOT survivable by falling back to the hire's own
  // dates: that is exactly the 46%-wrong week key this report exists to replace.
  // Surface it so the client can refuse to render or export a wrong week.
  return NextResponse.json(
    {
      rows: stripRates(rows),
      checklistWeeks,
      scope: elevated ? 'elevated' : 'department',
      departments,
      error: ckErr,
    },
    { status: ckErr ? 500 : 200 },
  );
}
