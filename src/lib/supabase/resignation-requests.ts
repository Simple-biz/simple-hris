import { createSupabaseServiceRoleClient } from './server';

/**
 * Employee-initiated resignation → department-manager approval → offboarding
 * queue. Mirrors the leave_requests shape (see src/lib/supabase/leave-requests.ts)
 * on the request/approval side; on approval the route reuses the offboarding_queue
 * machinery unchanged. Migration: references/sql/migrate/2026-07-04_resignation_requests.sql
 */

export type ResignationRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export type ResignationRequestRow = {
  id: string;
  employee_email: string;
  employee_name: string | null;
  employee_work_email: string | null;
  employee_personal_email: string | null;
  department: string | null;
  effective_date: string;
  message: string | null;
  status: ResignationRequestStatus;
  manager_email: string | null;
  approver_email: string | null;
  approver_note: string | null;
  decided_at: string | null;
  offboarding_queue_id: string | null;
  created_at: string;
  updated_at: string;
};

const TABLE = 'resignation_requests';

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

export type NewResignationRequest = {
  employee_email: string;
  employee_name: string | null;
  employee_work_email: string | null;
  employee_personal_email: string | null;
  department: string | null;
  effective_date: string;
  message: string | null;
  manager_email: string | null;
};

export async function insertResignationRequest(
  row: NewResignationRequest,
): Promise<{ id: string | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { id: null, error: 'Supabase not configured' };

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      employee_email: norm(row.employee_email),
      employee_name: row.employee_name?.trim() || null,
      employee_work_email: norm(row.employee_work_email) || null,
      employee_personal_email: norm(row.employee_personal_email) || null,
      department: row.department?.trim() || null,
      effective_date: row.effective_date.slice(0, 10),
      message: row.message?.trim() || null,
      manager_email: row.manager_email?.trim() || null,
      status: 'pending',
    })
    .select('id')
    .single();

  if (error) return { id: null, error: error.message };
  return { id: (data as { id: string } | null)?.id ?? null, error: null };
}

/** One person may only have one in-flight (pending) resignation at a time. */
export async function hasActiveResignation(emails: string[]): Promise<boolean> {
  const wanted = Array.from(new Set(emails.map(norm).filter(Boolean)));
  if (wanted.length === 0) return false;
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return false;
  const { data } = await supabase
    .from(TABLE)
    .select('employee_email, employee_work_email, employee_personal_email, status')
    .eq('status', 'pending');
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    for (const col of ['employee_email', 'employee_work_email', 'employee_personal_email']) {
      const v = norm(r[col] as string | null | undefined);
      if (v && wanted.includes(v)) return true;
    }
  }
  return false;
}

/** An employee's own resignation history, newest-first. */
export async function listResignationRequestsByEmployee(
  emails: string[],
): Promise<{ rows: ResignationRequestRow[]; error: string | null }> {
  const wanted = Array.from(new Set(emails.map(norm).filter(Boolean)));
  if (wanted.length === 0) return { rows: [], error: null };
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  // Match on any of the three email columns so a login on either address finds
  // the row regardless of which email was primary at submit time.
  const or = wanted
    .flatMap((e) => [
      `employee_email.eq.${e}`,
      `employee_work_email.eq.${e}`,
      `employee_personal_email.eq.${e}`,
    ])
    .join(',');
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .or(or)
    .order('created_at', { ascending: false });
  return { rows: (data ?? []) as ResignationRequestRow[], error: error?.message ?? null };
}

/** Every request (manager/HR/admin view), pending-first then newest-first. */
export async function listAllResignationRequests(limit = 400): Promise<{
  rows: ResignationRequestRow[];
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  return { rows: (data ?? []) as ResignationRequestRow[], error: error?.message ?? null };
}

export async function getResignationRequestById(id: string): Promise<{
  row: ResignationRequestRow | null;
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };
  const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
  return { row: (data as ResignationRequestRow) ?? null, error: error?.message ?? null };
}

/**
 * Manager approves or rejects a pending resignation. The `.eq('status','pending')`
 * guard makes the transition ATOMIC — a concurrent decision touches 0 rows
 * (updated === 0) instead of clobbering the first decision's audit fields; the
 * route turns that into a 409.
 */
export async function decideResignationRequest(params: {
  id: string;
  status: Extract<ResignationRequestStatus, 'approved' | 'rejected'>;
  approver_email: string;
  approver_note: string | null;
  offboarding_queue_id: string | null;
}): Promise<{ updated: number; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { updated: 0, error: 'Supabase not configured' };
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from(TABLE)
    .update({
      status: params.status,
      approver_email: norm(params.approver_email) || params.approver_email,
      approver_note: params.approver_note,
      offboarding_queue_id: params.offboarding_queue_id,
      decided_at: now,
      updated_at: now,
    })
    .eq('id', params.id)
    .eq('status', 'pending')
    .select('id');
  if (error) return { updated: 0, error: error.message };
  return { updated: (data ?? []).length, error: null };
}

/** Employee withdraws their own still-pending resignation. */
export async function cancelResignationRequestIfOwned(params: {
  id: string;
  emails: string[];
}): Promise<{ updated: number; error: string | null }> {
  const wanted = Array.from(new Set(params.emails.map(norm).filter(Boolean)));
  if (wanted.length === 0) return { updated: 0, error: null };
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { updated: 0, error: 'Supabase not configured' };
  const now = new Date().toISOString();
  const or = wanted
    .flatMap((e) => [
      `employee_email.eq.${e}`,
      `employee_work_email.eq.${e}`,
      `employee_personal_email.eq.${e}`,
    ])
    .join(',');
  const { data, error } = await supabase
    .from(TABLE)
    .update({ status: 'cancelled', updated_at: now, decided_at: now })
    .eq('id', params.id)
    .or(or)
    .eq('status', 'pending')
    .select('id');
  if (error) return { updated: 0, error: error.message };
  return { updated: (data ?? []).length, error: null };
}
