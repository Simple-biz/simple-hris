import 'server-only';

import { createSupabaseServiceRoleClient } from './server';
import { normEmail } from '@/lib/email/norm-email';

/**
 * Bank Preferred change requests — the accounting approval gate.
 *
 * When an employee changes their Bank Preferred (Profile → Payment), the new
 * value is held here as a `pending` row instead of being written straight to
 * employee_ids.bank_preferred. Accounting approves/denies in the Issues tab; on
 * approve the value is written to employee_ids and `applied_at` is stamped.
 * Mirrors the mesa_requests workflow. See
 * references/sql/create/bank_preferred_change_requests.sql.
 */

const TABLE = 'bank_preferred_change_requests';

export type BankPreferredRequestStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'superseded';

export interface BankPreferredRequestRow {
  id: string;
  work_email: string;
  employee_name: string | null;
  /** Current bank_preferred at request time (processor id, or null first-time). */
  from_value: string | null;
  /** Requested bank_preferred (processor id). */
  to_value: string;
  status: BankPreferredRequestStatus;
  review_notes: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  applied_at: string | null;
  created_at: string;
}

const SELECT_COLS =
  'id, work_email, employee_name, from_value, to_value, status, review_notes, reviewed_by, reviewed_at, applied_at, created_at';

/** True when a bank-preferred-requests table/relation is missing (un-migrated env). */
export function isBankPreferredRequestsMissing(message: string | null | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    (m.includes('relation') && m.includes(TABLE)) ||
    (m.includes('could not find the table') && m.includes(TABLE)) ||
    (m.includes(TABLE) && m.includes('does not exist')) ||
    m.includes('schema cache')
  );
}

/**
 * File a new pending Bank Preferred change request, superseding any existing
 * pending row for the same employee first (one-pending-per-employee invariant).
 * Best-effort supersede; the insert is the authoritative step.
 */
export async function createBankPreferredRequest(input: {
  workEmail: string;
  employeeName: string | null;
  fromValue: string | null;
  toValue: string;
}): Promise<{ id: string | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { id: null, error: 'Supabase not configured' };

  const workEmail = normEmail(input.workEmail) ?? input.workEmail.trim().toLowerCase();

  // Supersede any prior pending request for this employee so the partial unique
  // index doesn't reject the new insert and accounting only sees the latest ask.
  await supabase
    .from(TABLE)
    .update({ status: 'superseded' })
    .eq('work_email', workEmail)
    .eq('status', 'pending');

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      work_email: workEmail,
      employee_name: input.employeeName,
      from_value: input.fromValue,
      to_value: input.toValue,
    })
    .select('id')
    .single();

  if (error) return { id: null, error: error.message };
  return { id: (data?.id as string) ?? null, error: null };
}

/** The employee's most recent request (any status), or null. */
export async function getLatestBankPreferredRequest(
  email: string,
): Promise<{ row: BankPreferredRequestRow | null; error: string | null }> {
  const target = normEmail(email);
  if (!target) return { row: null, error: null };

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };

  const { data, error } = await supabase
    .from(TABLE)
    .select(SELECT_COLS)
    .ilike('work_email', target)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) return { row: null, error: error.message };
  const row = (Array.isArray(data) && data[0] ? data[0] : null) as BankPreferredRequestRow | null;
  return { row, error: null };
}

/** All requests, newest first, optionally filtered by status. Accounting view. */
export async function listBankPreferredRequests(opts?: {
  status?: BankPreferredRequestStatus;
  limit?: number;
}): Promise<{ rows: BankPreferredRequestRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };

  let q = supabase
    .from(TABLE)
    .select(SELECT_COLS)
    .order('created_at', { ascending: false })
    .limit(opts?.limit ?? 200);
  if (opts?.status) q = q.eq('status', opts.status);

  const { data, error } = await q;
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as BankPreferredRequestRow[], error: null };
}

/** One request by id. */
export async function getBankPreferredRequestById(
  id: string,
): Promise<{ row: BankPreferredRequestRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };

  const { data, error } = await supabase
    .from(TABLE)
    .select(SELECT_COLS)
    .eq('id', id)
    .single();

  if (error) return { row: null, error: error.message };
  return { row: (data as BankPreferredRequestRow) ?? null, error: null };
}
