import { createSupabaseServiceRoleClient } from './server';

export type OrphanageBudgetRequestStatus = 'pending' | 'approved' | 'rejected';
export type OrphanageBudgetRequestVisitType = 'monthly' | 'frequent' | 'special';

export interface OrphanageBudgetRequestRow {
  id: string;
  submitter_email: string;
  submitted_at: string;
  visit_type: OrphanageBudgetRequestVisitType;
  mission_trip: boolean;
  notes: string | null;
  subtotal: number;
  leftover: number;
  final_amount: number;
  payload: Record<string, unknown>;
  bank_account_name: string;
  bank_account_number: string;
  bank_name: string;
  swift_code: string;
  status: OrphanageBudgetRequestStatus;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface InsertOrphanageBudgetRequestInput {
  submitter_email: string;
  visit_type: OrphanageBudgetRequestVisitType;
  mission_trip: boolean;
  notes?: string | null;
  subtotal: number;
  leftover: number;
  final_amount: number;
  payload: Record<string, unknown>;
  bank_account_name: string;
  bank_account_number: string;
  bank_name: string;
  swift_code: string;
}

export async function insertOrphanageBudgetRequest(
  input: InsertOrphanageBudgetRequestInput,
): Promise<{ row: OrphanageBudgetRequestRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };

  const { data, error } = await supabase
    .from('orphanage_budget_requests')
    .insert({
      submitter_email: input.submitter_email,
      visit_type: input.visit_type,
      mission_trip: input.mission_trip,
      notes: input.notes ?? null,
      subtotal: input.subtotal,
      leftover: input.leftover,
      final_amount: input.final_amount,
      payload: input.payload,
      bank_account_name: input.bank_account_name,
      bank_account_number: input.bank_account_number,
      bank_name: input.bank_name,
      swift_code: input.swift_code,
    })
    .select('*')
    .single();

  if (error) return { row: null, error: error.message };
  return { row: data as OrphanageBudgetRequestRow, error: null };
}

export async function listOrphanageBudgetRequests(params: {
  /** When set, returns only requests submitted by this email (case-insensitive). */
  submitterEmail?: string;
  status?: OrphanageBudgetRequestStatus;
  limit?: number;
} = {}): Promise<{
  rows: OrphanageBudgetRequestRow[];
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };

  let q = supabase
    .from('orphanage_budget_requests')
    .select('*')
    .order('submitted_at', { ascending: false });

  if (params.submitterEmail) {
    q = q.eq('submitter_email', params.submitterEmail.trim().toLowerCase());
  }
  if (params.status) {
    q = q.eq('status', params.status);
  }
  if (params.limit && params.limit > 0) {
    q = q.limit(params.limit);
  }

  const { data, error } = await q;
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as OrphanageBudgetRequestRow[], error: null };
}

export async function decideOrphanageBudgetRequest(input: {
  id: string;
  status: 'approved' | 'rejected';
  decided_by: string;
  decision_note?: string | null;
}): Promise<{ row: OrphanageBudgetRequestRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };

  const { data, error } = await supabase
    .from('orphanage_budget_requests')
    .update({
      status: input.status,
      decided_by: input.decided_by,
      decided_at: new Date().toISOString(),
      decision_note: input.decision_note ?? null,
    })
    .eq('id', input.id)
    .select('*')
    .single();

  if (error) return { row: null, error: error.message };
  return { row: data as OrphanageBudgetRequestRow, error: null };
}

export async function getOrphanageBudgetRequest(
  id: string,
): Promise<{ row: OrphanageBudgetRequestRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };

  const { data, error } = await supabase
    .from('orphanage_budget_requests')
    .select('*')
    .eq('id', id)
    .single();

  if (error) return { row: null, error: error.message };
  return { row: data as OrphanageBudgetRequestRow, error: null };
}

/**
 * Audit-log entries for a single budget request. Reads from `public.audit_log`
 * filtered by `resource = 'orphanage_budget_requests'` AND `resource_id = id`.
 * Used by the History page's per-row timeline.
 */
export async function fetchOrphanageBudgetAuditTrail(
  id: string,
): Promise<{
  rows: {
    id: string;
    user_name: string;
    user_role: string;
    action: string;
    details: Record<string, unknown> | null;
    created_at: string;
  }[];
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };

  const { data, error } = await supabase
    .from('audit_log')
    .select('id, user_name, user_role, action, details, created_at')
    .eq('resource', 'orphanage_budget_requests')
    .eq('resource_id', id)
    .order('created_at', { ascending: true });

  if (error) return { rows: [], error: error.message };
  return {
    rows: (data ?? []) as {
      id: string;
      user_name: string;
      user_role: string;
      action: string;
      details: Record<string, unknown> | null;
      created_at: string;
    }[],
    error: null,
  };
}
