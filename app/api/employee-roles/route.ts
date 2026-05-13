import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import {
  authorizeEmailAccess,
  deniedResponse,
  requireElevatedSession,
} from '@/lib/auth/authorize-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const VALID_ROLES = [
  'viewer',
  'hr_coordinator',
  'payroll_coordinator',
  'payroll_manager',
  'finance',
  'admin',
  'manager',
  'orphanage_manager',
  'contractor',
  'ceo',
] as const;
type Role = (typeof VALID_ROLES)[number];

const SYSTEM_USER = { name: 'Fran M', role: 'Senior Admin' };

function getClient() {
  return createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
}

// GET /api/employee-roles            -> all active assignments
// GET /api/employee-roles?email=...  -> active roles for one employee
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = searchParams.get('email');

  // Listing all assignments is elevated-only; querying for one email is self-or-elevated.
  const authz = email
    ? await authorizeEmailAccess(email)
    : await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const supabase = getClient();
  if (!supabase) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  let q = supabase
    .from('employee_roles')
    .select('id, work_email, role, assigned_by, assigned_at, revoked_at')
    .is('revoked_at', null)
    .order('assigned_at', { ascending: false });

  if (email) q = q.ilike('work_email', authz.effectiveEmail);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}

// POST /api/employee-roles { work_email, role }  -> grant
export async function POST(request: Request) {
  try {
    const { work_email, role } = (await request.json()) as { work_email?: string; role?: string };
    if (!work_email || !role) {
      return NextResponse.json({ error: 'Missing work_email or role' }, { status: 400 });
    }
    if (!VALID_ROLES.includes(role as Role)) {
      return NextResponse.json({ error: `Invalid role. Expected one of: ${VALID_ROLES.join(', ')}` }, { status: 400 });
    }

    const supabase = getClient();
    if (!supabase) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

    const email = work_email.trim().toLowerCase();

    // If a revoked row exists, un-revoke it; otherwise insert new.
    const { data: existing } = await supabase
      .from('employee_roles')
      .select('id, revoked_at')
      .ilike('work_email', email)
      .eq('role', role)
      .limit(1)
      .maybeSingle();

    let error: string | null = null;
    if (existing) {
      if (existing.revoked_at === null) {
        return NextResponse.json({ success: true, alreadyActive: true });
      }
      const { error: upErr } = await supabase
        .from('employee_roles')
        .update({ revoked_at: null, assigned_by: SYSTEM_USER.name, assigned_at: new Date().toISOString() })
        .eq('id', existing.id);
      error = upErr?.message ?? null;
    } else {
      const { error: insErr } = await supabase
        .from('employee_roles')
        .insert({ work_email: email, role, assigned_by: SYSTEM_USER.name });
      error = insErr?.message ?? null;
    }

    if (error) {
      const hint =
        /employee_roles_role_check|violates check constraint.*employee_roles/i.test(error)
          ? ' Run references/employee_roles_widen_role_check_orphanage_manager.sql (or widen employee_roles_role_check to include this role).'
          : '';
      return NextResponse.json({ error: `${error}${hint}` }, { status: 500 });
    }

    void insertAuditLog({
      user_name: SYSTEM_USER.name,
      user_role: SYSTEM_USER.role,
      action: 'rbac.role.granted',
      resource: 'employee_roles',
      resource_id: email,
      details: { target_email: email, role },
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// DELETE /api/employee-roles?email=...&role=...  -> revoke
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const work_email = searchParams.get('email');
    const role = searchParams.get('role');
    if (!work_email || !role) {
      return NextResponse.json({ error: 'Missing email or role' }, { status: 400 });
    }

    const supabase = getClient();
    if (!supabase) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

    const email = work_email.trim().toLowerCase();
    const { error } = await supabase
      .from('employee_roles')
      .update({ revoked_at: new Date().toISOString() })
      .ilike('work_email', email)
      .eq('role', role)
      .is('revoked_at', null);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    void insertAuditLog({
      user_name: SYSTEM_USER.name,
      user_role: SYSTEM_USER.role,
      action: 'rbac.role.revoked',
      resource: 'employee_roles',
      resource_id: email,
      details: { target_email: email, role },
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
