import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { requireElevatedSession, deniedResponse } from '@/lib/auth/authorize-email';
import {
  assignManagerDepartment,
  listAllDepartmentManagers,
  listDepartmentsForManager,
  revokeManagerDepartment,
} from '@/lib/supabase/department-managers';
import { insertAuditLog } from '@/lib/supabase/audit-log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function clientIp(request: Request): string | null {
  const fwd = request.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : request.headers.get('x-real-ip');
}

async function requireAdmin() {
  const authz = await requireElevatedSession();
  if (!authz.ok) return { ok: false as const, response: deniedResponse(authz) };
  const session = await getServerSession(authOptions);
  const roles = ((session?.user as { roles?: string[] } | undefined)?.roles ?? []) as string[];
  if (!roles.includes('admin')) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: 'Admin role required' }, { status: 403 }),
    };
  }
  return { ok: true as const, sessionEmail: authz.sessionEmail };
}

// GET /api/department-managers              -> all active rows
// GET /api/department-managers?email=...    -> active rows for one manager
export async function GET(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { searchParams } = new URL(request.url);
  const email = searchParams.get('email');
  if (email) {
    const { rows, error } = await listDepartmentsForManager(email);
    if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
    return NextResponse.json({ rows, error: null });
  }
  const { rows, error } = await listAllDepartmentManagers();
  if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
  return NextResponse.json({ rows, error: null });
}

// POST /api/department-managers { manager_email, department }
export async function POST(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  try {
    const body = (await request.json()) as { manager_email?: string; department?: string };
    const manager_email = body.manager_email?.trim();
    const department = body.department?.trim();
    if (!manager_email || !department) {
      return NextResponse.json(
        { error: 'manager_email and department are required' },
        { status: 400 },
      );
    }
    const { id, error } = await assignManagerDepartment({
      manager_email,
      department,
      assigned_by: guard.sessionEmail,
    });
    if (error) return NextResponse.json({ error }, { status: 500 });

    void insertAuditLog({
      user_name: guard.sessionEmail,
      user_role: 'Admin',
      action: 'department_manager.assigned',
      resource: 'department_managers',
      resource_id: id ?? undefined,
      details: { manager_email: manager_email.toLowerCase(), department },
      ip_address: clientIp(request),
    });
    return NextResponse.json({ success: true, id, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// DELETE /api/department-managers?email=...&department=...
export async function DELETE(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { searchParams } = new URL(request.url);
  const manager_email = searchParams.get('email')?.trim();
  const department = searchParams.get('department')?.trim();
  if (!manager_email || !department) {
    return NextResponse.json(
      { error: 'email and department query params are required' },
      { status: 400 },
    );
  }
  const { error } = await revokeManagerDepartment({ manager_email, department });
  if (error) return NextResponse.json({ error }, { status: 500 });

  void insertAuditLog({
    user_name: guard.sessionEmail,
    user_role: 'Admin',
    action: 'department_manager.revoked',
    resource: 'department_managers',
    details: { manager_email: manager_email.toLowerCase(), department },
    ip_address: clientIp(request),
  });
  return NextResponse.json({ success: true, error: null });
}
