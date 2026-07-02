import { createSupabaseServiceRoleClient } from './server';

export type OffboardingQueueStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'dismissed'
  | 'cancelled';

export type OffboardingQueueRow = {
  id: string;
  employee_email: string;
  employee_name: string | null;
  employee_work_email: string | null;
  employee_personal_email: string | null;
  department: string | null;
  reason: string;
  note: string | null;
  status: OffboardingQueueStatus;
  requested_by: string;
  requested_by_name: string | null;
  processed_by: string | null;
  processed_note: string | null;
  offboard_reason: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
};

export type NewOffboardingQueueEntry = {
  employee_email: string;
  employee_name: string | null;
  employee_work_email: string | null;
  employee_personal_email: string | null;
  department: string | null;
  reason: string;
  note: string | null;
};

const TABLE = 'offboarding_queue';

/** Statuses that occupy a person — a second request for them is a dupe. */
const ACTIVE_STATUSES: OffboardingQueueStatus[] = ['pending', 'processing'];

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/** Bulk-insert queue entries (a manager submits several people at once). */
export async function insertOffboardingQueueEntries(params: {
  entries: NewOffboardingQueueEntry[];
  requested_by: string;
  requested_by_name: string | null;
}): Promise<{ rows: OffboardingQueueRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  if (params.entries.length === 0) return { rows: [], error: null };

  const requestedBy = norm(params.requested_by);
  const payload = params.entries.map((e) => ({
    employee_email: norm(e.employee_email),
    employee_name: e.employee_name?.trim() || null,
    employee_work_email: norm(e.employee_work_email) || null,
    employee_personal_email: norm(e.employee_personal_email) || null,
    department: e.department?.trim() || null,
    reason: e.reason.trim(),
    note: e.note?.trim() || null,
    status: 'pending' as const,
    requested_by: requestedBy,
    requested_by_name: params.requested_by_name?.trim() || null,
  }));

  const { data, error } = await supabase.from(TABLE).insert(payload).select('*');
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as OffboardingQueueRow[], error: null };
}

/** Every request (HR / admin approval queue), pending-first then newest-first. */
export async function listAllOffboardingQueue(limit = 400): Promise<{
  rows: OffboardingQueueRow[];
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  return { rows: (data ?? []) as OffboardingQueueRow[], error: error?.message ?? null };
}

/** Requests raised by one manager (their own outbox → My Team status badges). */
export async function listOffboardingQueueByRequester(
  requesterEmail: string,
  limit = 400,
): Promise<{ rows: OffboardingQueueRow[]; error: string | null }> {
  const e = norm(requesterEmail);
  if (!e) return { rows: [], error: null };
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .ilike('requested_by', e)
    .order('created_at', { ascending: false })
    .limit(limit);
  return { rows: (data ?? []) as OffboardingQueueRow[], error: error?.message ?? null };
}

export async function getOffboardingQueueById(id: string): Promise<{
  row: OffboardingQueueRow | null;
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };
  const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
  return { row: (data as OffboardingQueueRow) ?? null, error: error?.message ?? null };
}

/**
 * Which of the given emails already have an in-flight (pending/processing)
 * queue entry. Returns a Set of the normalized emails that are occupied, so the
 * caller can skip re-queueing them. Matches on any of the three email columns.
 */
export async function findEmailsWithActiveOffboarding(
  emails: string[],
): Promise<Set<string>> {
  const occupied = new Set<string>();
  const wanted = new Set(emails.map(norm).filter(Boolean));
  if (wanted.size === 0) return occupied;

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return occupied;
  const { data } = await supabase
    .from(TABLE)
    .select('employee_email, employee_work_email, employee_personal_email, status')
    .in('status', ACTIVE_STATUSES);

  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    for (const col of ['employee_email', 'employee_work_email', 'employee_personal_email']) {
      const v = norm(r[col] as string | null | undefined);
      if (v && wanted.has(v)) occupied.add(v);
    }
  }
  return occupied;
}

/** Set a batch of pending rows to 'processing' (HR claimed them), or release
 *  a batch of processing rows back to 'pending' (HR closed the processor). */
export async function setOffboardingQueueBatchStatus(params: {
  ids: string[];
  from: OffboardingQueueStatus;
  to: OffboardingQueueStatus;
}): Promise<{ updated: number; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { updated: 0, error: 'Supabase not configured' };
  if (params.ids.length === 0) return { updated: 0, error: null };
  const { data, error } = await supabase
    .from(TABLE)
    .update({ status: params.to, updated_at: new Date().toISOString() })
    .in('id', params.ids)
    .eq('status', params.from)
    .select('id');
  if (error) return { updated: 0, error: error.message };
  return { updated: (data ?? []).length, error: null };
}

/**
 * HR completes (offboarded) or dismisses (rejected) a single request.
 *
 * The `.in('status', ['pending','processing'])` guard makes the transition
 * ATOMIC — if a concurrent request already marked the row terminal, this update
 * touches 0 rows (updated === 0) instead of clobbering the earlier decision's
 * processed_by / decided_at audit fields. The caller turns updated === 0 into a
 * 409 so the second actor learns the request was already handled.
 */
export async function decideOffboardingQueueEntry(params: {
  id: string;
  status: Extract<OffboardingQueueStatus, 'completed' | 'dismissed'>;
  processed_by: string;
  processed_note: string | null;
  offboard_reason: string | null;
}): Promise<{ updated: number; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { updated: 0, error: 'Supabase not configured' };
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from(TABLE)
    .update({
      status: params.status,
      processed_by: norm(params.processed_by) || params.processed_by,
      processed_note: params.processed_note,
      offboard_reason: params.offboard_reason,
      decided_at: now,
      updated_at: now,
    })
    .eq('id', params.id)
    .in('status', ['pending', 'processing']) // only in-flight rows can be decided
    .select('id');
  if (error) return { updated: 0, error: error.message };
  return { updated: (data ?? []).length, error: null };
}

/** Manager withdraws their own still-pending request. */
export async function cancelOffboardingQueueIfOwned(params: {
  id: string;
  requested_by: string;
}): Promise<{ updated: number; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { updated: 0, error: 'Supabase not configured' };
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from(TABLE)
    .update({ status: 'cancelled', updated_at: now, decided_at: now })
    .eq('id', params.id)
    .ilike('requested_by', norm(params.requested_by))
    .in('status', ['pending']) // only a still-pending request can be withdrawn
    .select('id');
  if (error) return { updated: 0, error: error.message };
  return { updated: (data ?? []).length, error: null };
}
