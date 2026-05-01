import { createSupabaseServiceRoleClient } from './server';

export type DepartmentManagerRow = {
  id: string;
  manager_email: string;
  department: string;
  assigned_by: string | null;
  assigned_at: string;
  revoked_at: string | null;
};

const TABLE = 'department_managers';

/** Every active manager-department pair, newest first. */
export async function listAllDepartmentManagers(): Promise<{
  rows: DepartmentManagerRow[];
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .is('revoked_at', null)
    .order('assigned_at', { ascending: false });
  return { rows: (data ?? []) as DepartmentManagerRow[], error: error?.message ?? null };
}

/** Active department assignments for a single manager email. */
export async function listDepartmentsForManager(
  email: string | null | undefined,
): Promise<{ rows: DepartmentManagerRow[]; error: string | null }> {
  const e = email?.trim().toLowerCase();
  if (!e) return { rows: [], error: null };
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .ilike('manager_email', e)
    .is('revoked_at', null)
    .order('department', { ascending: true });
  return { rows: (data ?? []) as DepartmentManagerRow[], error: error?.message ?? null };
}

/** Active manager emails for a single department (case-insensitive). */
export async function listManagersByDepartment(
  department: string | null | undefined,
): Promise<string[]> {
  const dept = department?.trim().toLowerCase();
  if (!dept) return [];
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from(TABLE)
    .select('manager_email,department')
    .is('revoked_at', null);
  if (error) return [];
  const out = new Set<string>();
  for (const row of (data ?? []) as Array<{ manager_email: string; department: string }>) {
    if (row.department.trim().toLowerCase() === dept) {
      const e = row.manager_email.trim().toLowerCase();
      if (e) out.add(e);
    }
  }
  return Array.from(out);
}

export async function assignManagerDepartment(params: {
  manager_email: string;
  department: string;
  assigned_by: string | null;
}): Promise<{ id: string | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { id: null, error: 'Supabase not configured' };
  const email = params.manager_email.trim().toLowerCase();
  const dept = params.department.trim();
  if (!email || !dept) return { id: null, error: 'manager_email and department are required' };

  // If a revoked row already exists for this pair, un-revoke it; otherwise insert.
  const { data: existing } = await supabase
    .from(TABLE)
    .select('id, revoked_at')
    .ilike('manager_email', email)
    .ilike('department', dept)
    .limit(1)
    .maybeSingle();

  if (existing) {
    if (existing.revoked_at === null) return { id: existing.id, error: null };
    const { error } = await supabase
      .from(TABLE)
      .update({
        revoked_at: null,
        assigned_at: new Date().toISOString(),
        assigned_by: params.assigned_by,
      })
      .eq('id', existing.id);
    return { id: existing.id, error: error?.message ?? null };
  }

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      manager_email: email,
      department: dept,
      assigned_by: params.assigned_by,
    })
    .select('id')
    .single();
  return { id: (data as { id: string } | null)?.id ?? null, error: error?.message ?? null };
}

export async function revokeManagerDepartment(params: {
  manager_email: string;
  department: string;
}): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };
  const email = params.manager_email.trim().toLowerCase();
  const dept = params.department.trim();
  if (!email || !dept) return { error: 'manager_email and department are required' };
  const { error } = await supabase
    .from(TABLE)
    .update({ revoked_at: new Date().toISOString() })
    .ilike('manager_email', email)
    .ilike('department', dept)
    .is('revoked_at', null);
  return { error: error?.message ?? null };
}

/** Revokes every department for a manager — used when the role is removed. */
export async function revokeAllForManager(email: string): Promise<{ error: string | null }> {
  const e = email.trim().toLowerCase();
  if (!e) return { error: null };
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };
  const { error } = await supabase
    .from(TABLE)
    .update({ revoked_at: new Date().toISOString() })
    .ilike('manager_email', e)
    .is('revoked_at', null);
  return { error: error?.message ?? null };
}
