import { createSupabaseServiceRoleClient } from './server';

export type TransferRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export type DepartmentTransferRequestRow = {
  id: string;
  employee_email: string;
  employee_name: string | null;
  employee_work_email: string | null;
  employee_personal_email: string | null;
  from_department: string;
  to_department: string;
  reason: string | null;
  status: TransferRequestStatus;
  requested_by: string;
  approver_email: string | null;
  approver_note: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
};

const TABLE = 'department_transfer_requests';
const MASTER_TABLE = 'global_master_list';

export async function insertTransferRequest(row: {
  employee_email: string;
  employee_name: string | null;
  employee_work_email: string | null;
  employee_personal_email: string | null;
  from_department: string;
  to_department: string;
  reason: string | null;
  requested_by: string;
}): Promise<{ id: string | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { id: null, error: 'Supabase not configured' };

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      employee_email: row.employee_email.trim().toLowerCase(),
      employee_name: row.employee_name,
      employee_work_email: row.employee_work_email?.trim().toLowerCase() || null,
      employee_personal_email: row.employee_personal_email?.trim().toLowerCase() || null,
      from_department: row.from_department.trim(),
      to_department: row.to_department.trim(),
      reason: row.reason?.trim() || null,
      requested_by: row.requested_by.trim().toLowerCase(),
      status: 'pending',
    })
    .select('id')
    .single();

  if (error) return { id: null, error: error.message };
  return { id: (data as { id: string } | null)?.id ?? null, error: null };
}

export async function listAllTransferRequests(limit = 300): Promise<{
  rows: DepartmentTransferRequestRow[];
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  return { rows: (data ?? []) as DepartmentTransferRequestRow[], error: error?.message ?? null };
}

/** Requests raised by one manager (their own outbox). */
export async function listTransferRequestsByRequester(
  requesterEmail: string,
  limit = 300,
): Promise<{ rows: DepartmentTransferRequestRow[]; error: string | null }> {
  const e = requesterEmail.trim().toLowerCase();
  if (!e) return { rows: [], error: null };
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .ilike('requested_by', e)
    .order('created_at', { ascending: false })
    .limit(limit);
  return { rows: (data ?? []) as DepartmentTransferRequestRow[], error: error?.message ?? null };
}

export async function getTransferRequestById(id: string): Promise<{
  row: DepartmentTransferRequestRow | null;
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };
  const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
  return { row: (data as DepartmentTransferRequestRow) ?? null, error: error?.message ?? null };
}

/** True when this employee already has a pending transfer request (prevents dupes). */
export async function hasPendingTransferForEmployee(
  employeeEmail: string,
): Promise<boolean> {
  const e = employeeEmail.trim().toLowerCase();
  if (!e) return false;
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return false;
  const { data } = await supabase
    .from(TABLE)
    .select('id')
    .eq('status', 'pending')
    .or(`employee_email.ilike.${e},employee_work_email.ilike.${e},employee_personal_email.ilike.${e}`)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

export async function updateTransferRequestStatus(params: {
  id: string;
  status: TransferRequestStatus;
  approver_email: string | null;
  approver_note: string | null;
}): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };
  const now = new Date().toISOString();
  const { error } = await supabase
    .from(TABLE)
    .update({
      status: params.status,
      approver_email: params.approver_email,
      approver_note: params.approver_note,
      decided_at: params.status === 'pending' ? null : now,
      updated_at: now,
    })
    .eq('id', params.id);
  return { error: error?.message ?? null };
}

export async function cancelTransferRequestIfOwned(params: {
  id: string;
  requested_by: string;
}): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };
  const { error } = await supabase
    .from(TABLE)
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', params.id)
    .ilike('requested_by', params.requested_by.trim().toLowerCase())
    .eq('status', 'pending');
  return { error: error?.message ?? null };
}

/**
 * Applies an approved transfer to the master list: sets Department = to_department
 * on the employee's global_master_list row(s), matched by personal/work email AND
 * the current (from) department.
 *
 * Matching includes the current department so we only move the row that actually
 * lives in the source team -- an employee can hold rows in multiple departments and
 * we must not clobber the others. Returns how many rows were updated.
 */
export async function applyDepartmentTransfer(params: {
  personalEmail: string | null;
  workEmail: string | null;
  fromDepartment: string;
  toDepartment: string;
}): Promise<{ updated: number; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { updated: 0, error: 'Supabase not configured' };

  const to = params.toDepartment.trim();
  const from = params.fromDepartment.trim();
  if (!to) return { updated: 0, error: 'Target department is required' };

  const pe = params.personalEmail?.trim().toLowerCase() || null;
  const we = params.workEmail?.trim().toLowerCase() || null;
  if (!pe && !we) return { updated: 0, error: 'Employee has no email on file to match' };

  // Pull candidate rows in the source department, then match emails in memory so
  // we sidestep .or()-string quoting on space-containing column names.
  const { data, error } = await supabase
    .from(MASTER_TABLE)
    .select('id, "Personal Email", "Work Email", "Department"')
    .ilike('"Department"', from);
  if (error) return { updated: 0, error: error.message };

  const ids: Array<string | number> = [];
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const rPe = String(row['Personal Email'] ?? '').trim().toLowerCase();
    const rWe = String(row['Work Email'] ?? '').trim().toLowerCase();
    if ((pe && rPe === pe) || (we && rWe === we)) {
      ids.push(row.id as string | number);
    }
  }
  if (ids.length === 0) {
    return { updated: 0, error: 'No matching master-list row found for this employee in the source department' };
  }

  const { error: updErr } = await supabase
    .from(MASTER_TABLE)
    .update({ Department: to })
    .in('id', ids);
  if (updErr) return { updated: 0, error: updErr.message };
  return { updated: ids.length, error: null };
}
