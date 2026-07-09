import { createSupabaseServiceRoleClient } from './server';

export type TransferRequestStatus = 'pending' | 'approved' | 'applied' | 'rejected' | 'cancelled';

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
  /** v2: source-department manager who released/declined (reuses approver_*). */
  approver_email: string | null;
  approver_note: string | null;
  decided_at: string | null;
  /** v2: receiving manager's proposed effective date (YYYY-MM-DD). */
  proposed_effective_date: string | null;
  /** v2: effective date, LOCKED when the source manager releases. */
  effective_date: string | null;
  /** v2: when the dept change was written to master + Sheet. */
  applied_at: string | null;
  /** v2: did the Google Sheet write-back succeed? Drives the "Retry" badge. */
  sheet_synced: boolean;
  sheet_sync_error: string | null;
  created_at: string;
  updated_at: string;
};

/** v2 status semantics:
 *   pending   → awaiting the source manager's release decision
 *   approved  → released; effective_date locked; scheduled for that date
 *   applied   → department written to master + Sheet
 *   rejected  → source manager declined
 *   cancelled → receiving manager withdrew */

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
  /** v2: receiving manager's proposed effective date (YYYY-MM-DD), locked on release. */
  proposed_effective_date?: string | null;
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
      proposed_effective_date: row.proposed_effective_date?.trim() || null,
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

/** True when this employee already has an in-flight transfer — either awaiting a
 *  source-manager decision (`pending`) or released and scheduled but not yet
 *  applied (`approved`). Prevents raising a second request over an open one. */
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
    .in('status', ['pending', 'approved'])
    .or(`employee_email.ilike.${e},employee_work_email.ilike.${e},employee_personal_email.ilike.${e}`)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

/**
 * Pending release requests whose SOURCE department is one the given manager
 * owns — i.e. their consent queue. `departments` is the manager's active
 * department list (case-insensitive match on from_department).
 */
export async function listIncomingTransfersForDepartments(
  departments: string[],
  limit = 300,
): Promise<{ rows: DepartmentTransferRequestRow[]; error: string | null }> {
  const wanted = new Set(departments.map((d) => d.trim().toLowerCase()).filter(Boolean));
  if (wanted.size === 0) return { rows: [], error: null };
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return { rows: [], error: error.message };
  const rows = ((data ?? []) as DepartmentTransferRequestRow[]).filter((r) =>
    wanted.has(r.from_department.trim().toLowerCase()),
  );
  return { rows, error: null };
}

/** Source manager releases a pending request: locks the effective date and moves
 *  it to `approved`. The caller applies immediately if the date is already due. */
export async function releaseTransfer(params: {
  id: string;
  source_manager_email: string;
  effective_date: string; // YYYY-MM-DD
}): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };
  const now = new Date().toISOString();
  const { error } = await supabase
    .from(TABLE)
    .update({
      status: 'approved',
      approver_email: params.source_manager_email.trim().toLowerCase(),
      effective_date: params.effective_date,
      decided_at: now,
      updated_at: now,
    })
    .eq('id', params.id)
    .eq('status', 'pending');
  return { error: error?.message ?? null };
}

/** Source manager declines a pending request. */
export async function declineTransfer(params: {
  id: string;
  source_manager_email: string;
  note: string | null;
}): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };
  const now = new Date().toISOString();
  const { error } = await supabase
    .from(TABLE)
    .update({
      status: 'rejected',
      approver_email: params.source_manager_email.trim().toLowerCase(),
      approver_note: params.note,
      decided_at: now,
      updated_at: now,
    })
    .eq('id', params.id)
    .eq('status', 'pending');
  return { error: error?.message ?? null };
}

/** Marks a released transfer as applied, recording the Sheet write-back outcome. */
export async function markTransferApplied(params: {
  id: string;
  sheet_synced: boolean;
  sheet_sync_error: string | null;
}): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };
  const now = new Date().toISOString();
  const { error } = await supabase
    .from(TABLE)
    .update({
      status: 'applied',
      applied_at: now,
      sheet_synced: params.sheet_synced,
      sheet_sync_error: params.sheet_sync_error,
      updated_at: now,
    })
    .eq('id', params.id);
  return { error: error?.message ?? null };
}

/** Updates only the Sheet write-back outcome (used by the Retry action). */
export async function setTransferSheetSync(params: {
  id: string;
  sheet_synced: boolean;
  sheet_sync_error: string | null;
}): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };
  const { error } = await supabase
    .from(TABLE)
    .update({
      sheet_synced: params.sheet_synced,
      sheet_sync_error: params.sheet_sync_error,
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.id);
  return { error: error?.message ?? null };
}

/** Released transfers whose effective date is on/before `todayIso` and not yet
 *  applied — the daily apply-scheduled-transfers cron's work list. */
export async function listScheduledDueTransfers(
  todayIso: string,
): Promise<{ rows: DepartmentTransferRequestRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('status', 'approved')
    .not('effective_date', 'is', null)
    .lte('effective_date', todayIso)
    .order('effective_date', { ascending: true });
  return { rows: (data ?? []) as DepartmentTransferRequestRow[], error: error?.message ?? null };
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
