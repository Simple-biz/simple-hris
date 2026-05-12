import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { hasElevatedRole } from '@/lib/auth/elevated-roles';
import { listDepartmentsForManager } from '@/lib/supabase/department-managers';
import {
  clearPendingHireOrientation,
  markPendingHireOrientation,
} from '@/lib/supabase/hr-pending-employees';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function normEmail(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/**
 * Verifies the caller is a manager (or elevated) and — for non-elevated
 * managers — that the pending hire's department appears in their
 * department_managers assignments. Returns `{ ok: true, sessionEmail }` on
 * success or a NextResponse to short-circuit on failure.
 */
async function authorizeForHire(id: number) {
  const session = await getServerSession(authOptions);
  const user = session?.user as { email?: string | null; roles?: string[] } | undefined;
  const sessionEmail = normEmail(user?.email ?? null);
  if (!sessionEmail) {
    return { ok: false as const, res: NextResponse.json({ error: 'Not signed in' }, { status: 401 }) };
  }

  const roles = (user?.roles ?? []) as string[];
  if (!(roles.includes('manager') || roles.includes('admin'))) {
    return {
      ok: false as const,
      res: NextResponse.json({ error: 'Manager or admin role required' }, { status: 403 }),
    };
  }

  if (hasElevatedRole(roles)) {
    return { ok: true as const, sessionEmail };
  }

  // Department gate: load the pending row, compare its department against the
  // manager's department_managers assignments.
  const sb = createSupabaseServiceRoleClient();
  if (!sb) {
    return {
      ok: false as const,
      res: NextResponse.json({ error: 'Supabase not configured' }, { status: 500 }),
    };
  }
  const { data: hireRow, error: hireErr } = await sb
    .from('hr_pending_employees')
    .select('id, department, status')
    .eq('id', id)
    .single();
  if (hireErr || !hireRow) {
    return { ok: false as const, res: NextResponse.json({ error: 'Pending hire not found' }, { status: 404 }) };
  }

  const { rows: assigns } = await listDepartmentsForManager(sessionEmail);
  const allowed = new Set(assigns.map((a) => a.department.trim().toLowerCase()));
  const hireDept = (hireRow.department as string | null | undefined)?.trim().toLowerCase() ?? '';
  if (!allowed.has(hireDept)) {
    return {
      ok: false as const,
      res: NextResponse.json(
        { error: "You don't manage this hire's department." },
        { status: 403 },
      ),
    };
  }

  return { ok: true as const, sessionEmail };
}

/** POST — mark orientation as attended (idempotent). Body: { note?: string }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: idParam } = await params;
  const id = Number(idParam);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const authz = await authorizeForHire(id);
  if (!authz.ok) return authz.res;

  let body: { note?: string | null } = {};
  try {
    body = (await req.json()) as { note?: string | null };
  } catch {
    // empty body is fine
  }

  const { row, error } = await markPendingHireOrientation(id, {
    markedBy: authz.sessionEmail,
    note: body.note ?? null,
  });
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ row });
}

/** DELETE — clears the orientation marker (manager changed their mind / typo). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: idParam } = await params;
  const id = Number(idParam);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }
  const authz = await authorizeForHire(id);
  if (!authz.ok) return authz.res;

  const { row, error } = await clearPendingHireOrientation(id);
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ row });
}
