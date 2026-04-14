import { createSupabaseServiceRoleClient } from './server';

export type LeaveRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export type LeaveRequestRow = {
  id: string;
  employee_email: string;
  employee_name: string | null;
  department: string | null;
  start_date: string;
  end_date: string;
  leave_type: string;
  reason: string | null;
  status: LeaveRequestStatus;
  manager_email: string | null;
  created_at: string;
  updated_at: string;
  approver_email: string | null;
  approver_note: string | null;
};

function tableName(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_LEAVE_REQUESTS_TABLE?.trim() || 'leave_requests';
}

export async function insertLeaveRequest(row: {
  employee_email: string;
  employee_name: string | null;
  department: string | null;
  start_date: string;
  end_date: string;
  leave_type: string;
  reason: string | null;
  manager_email: string | null;
}): Promise<{ id: string | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { id: null, error: 'Supabase not configured' };

  const email = row.employee_email.trim().toLowerCase();
  const { data, error } = await supabase
    .from(tableName())
    .insert({
      employee_email: email,
      employee_name: row.employee_name,
      department: row.department,
      start_date: row.start_date,
      end_date: row.end_date,
      leave_type: row.leave_type,
      reason: row.reason,
      manager_email: row.manager_email?.trim() || null,
      status: 'pending',
    })
    .select('id')
    .single();

  if (error) return { id: null, error: error.message };
  return { id: (data as { id: string } | null)?.id ?? null, error: null };
}

export async function listLeaveRequestsByEmployee(
  emailNorm: string,
): Promise<{ rows: LeaveRequestRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };

  const { data, error } = await supabase
    .from(tableName())
    .select('*')
    .ilike('employee_email', emailNorm)
    .order('created_at', { ascending: false });

  return { rows: (data ?? []) as LeaveRequestRow[], error: error?.message ?? null };
}

export async function listAllLeaveRequests(limit = 200): Promise<{
  rows: LeaveRequestRow[];
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };

  const { data, error } = await supabase
    .from(tableName())
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  return { rows: (data ?? []) as LeaveRequestRow[], error: error?.message ?? null };
}

export async function updateLeaveRequestStatus(params: {
  id: string;
  status: LeaveRequestStatus;
  approver_email: string | null;
  approver_note: string | null;
}): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };

  const { error } = await supabase
    .from(tableName())
    .update({
      status: params.status,
      approver_email: params.approver_email,
      approver_note: params.approver_note,
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.id);

  return { error: error?.message ?? null };
}

export async function cancelLeaveRequestIfOwned(params: {
  id: string;
  employee_email: string;
}): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };

  const { error } = await supabase
    .from(tableName())
    .update({
      status: 'cancelled',
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.id)
    .ilike('employee_email', params.employee_email.trim().toLowerCase())
    .eq('status', 'pending');

  return { error: error?.message ?? null };
}

export async function getLeaveRequestById(id: string): Promise<{
  row: LeaveRequestRow | null;
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };

  const { data, error } = await supabase.from(tableName()).select('*').eq('id', id).maybeSingle();

  return { row: (data as LeaveRequestRow) ?? null, error: error?.message ?? null };
}

/**
 * `leave_department_managers_json` in app_settings: `{"Accounting":"mgr@co.com","Edit":"..."}`.
 * Matches department string case-insensitively; falls back to substring match.
 */
export function resolveManagerEmail(
  department: string | null | undefined,
  managersJson: string | null | undefined,
): string | null {
  if (!department?.trim() || !managersJson?.trim()) return null;
  try {
    const map = JSON.parse(managersJson) as Record<string, string>;
    if (!map || typeof map !== 'object') return null;
    const d = department.trim().toLowerCase();
    let best: string | null = null;
    for (const [k, v] of Object.entries(map)) {
      const key = k.trim().toLowerCase();
      const email = String(v ?? '').trim();
      if (!email) continue;
      if (key === d) return email;
      if (d.includes(key) || key.includes(d)) best = email;
    }
    return best;
  } catch {
    return null;
  }
}
