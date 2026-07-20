import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { hasElevatedRole } from '@/lib/auth/elevated-roles';
import { listDepartmentsForManager } from '@/lib/supabase/department-managers';
import { getEmployeesForAuthorizedServerRoute } from '@/lib/supabase/employees';
import type { EmployeeRow } from '@/lib/supabase/employees';
import { departmentMatchesManagedAssignments } from '@/lib/managed-department-scope';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function normEmail(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/**
 * PATCH — set (or clear) an employee's CallTools dialer username in the
 * per-employee manual store `employee_calltools_usernames`, from the Manager ->
 * My Team roster. This is the backfill/override path for existing Lead Gen staff
 * (the onboarding submission mints usernames only for hires who onboarded through
 * that feature; most current staff predate it / have no submission).
 *
 * Auth mirrors the roster read (`/api/manager/department-members`): manager or
 * admin only, and a non-elevated manager may only edit someone who is on a
 * department they manage. Elevated roles (admin/…) may edit anyone on the roster.
 *
 * Body: `{ email: string; username: string; name?: string }`. An empty/whitespace
 * `username` DELETES the row (reverts to the submission-derived value, if any).
 */
export async function PATCH(req: NextRequest) {
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

  let body: { email?: string; username?: string; name?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const targetEmail = normEmail(body.email);
  const username = (body.username ?? '').trim();
  const nameHint = (body.name ?? '').trim() || null;
  if (!targetEmail) {
    return NextResponse.json({ error: 'email is required' }, { status: 400 });
  }

  // Resolve the target against the authorized roster + confirm scope.
  const elevated = hasElevatedRole(roles);
  const [{ rows: assigns }, { employees, error }] = await Promise.all([
    listDepartmentsForManager(sessionEmail),
    getEmployeesForAuthorizedServerRoute(),
  ]);
  if (error) {
    return NextResponse.json({ error }, { status: 500 });
  }
  const departments = assigns.map((a) => a.department.trim()).filter(Boolean);

  const matchesEmail = (e: EmployeeRow): boolean =>
    [e.work_email, e.personal_email, e.alternate_work_email, e.alternate_work_email_2]
      .map(normEmail)
      .includes(targetEmail);
  const target = employees.find(matchesEmail);
  if (!target) {
    return NextResponse.json({ error: 'Employee not found on your roster' }, { status: 404 });
  }
  // Non-elevated managers are limited to the departments they manage.
  if (!elevated) {
    if (departments.length === 0) {
      return NextResponse.json({ error: 'No department assignments' }, { status: 403 });
    }
    if (!departmentMatchesManagedAssignments(target.department, departments)) {
      return NextResponse.json({ error: 'Not authorized for this employee' }, { status: 403 });
    }
  }

  const sb = createSupabaseServiceRoleClient();
  if (!sb) {
    return NextResponse.json({ error: 'Supabase service client unavailable' }, { status: 500 });
  }

  // Key the store row by the employee's primary work email (personal fallback),
  // so a roster row's work-email lookup always resolves it — regardless of which
  // of the employee's addresses the client happened to send.
  const keyEmail =
    normEmail(target.work_email) || normEmail(target.personal_email) || targetEmail;

  if (!username) {
    const { error: delErr } = await sb
      .from('employee_calltools_usernames')
      .delete()
      .eq('email', keyEmail);
    if (delErr) {
      return NextResponse.json({ error: delErr.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, email: keyEmail, username: null });
  }

  const { error: upErr } = await sb.from('employee_calltools_usernames').upsert(
    {
      email: keyEmail,
      calltools_username: username,
      name: nameHint ?? target.name ?? null,
      updated_by: sessionEmail,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'email' },
  );
  if (upErr) {
    // Pre-migration table absence surfaces as a clear, actionable error.
    const msg = /employee_calltools_usernames/i.test(upErr.message)
      ? `${upErr.message} — run references/sql/migrate/2026-07-20_employee_calltools_usernames.sql`
      : upErr.message;
    return NextResponse.json({ error: msg }, { status: 500 });
  }
  return NextResponse.json({ ok: true, email: keyEmail, username });
}
