import { createSupabaseServiceRoleClient } from './server';
import { insertAuditLog } from './audit-log';
import { getAppSetting } from './app-settings';
import { normEmail } from '@/lib/email/norm-email';

export type PabDisputeStatus = 'pending' | 'approved' | 'denied';

export type PabDayDisputeRow = {
  id: string;
  work_email: string;
  dispute_date: string;
  reason: string;
  explanation: string | null;
  status: PabDisputeStatus;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  override_hours: number | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
};

export type PabDisputeReasonCode = {
  code: string;
  label: string;
  min_hours: number;
};

const TABLE = 'pab_day_disputes';

export async function getDisputeReasonCodes(): Promise<PabDisputeReasonCode[]> {
  const raw = await getAppSetting('pab_dispute_reason_codes');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is PabDisputeReasonCode =>
        typeof r === 'object' && r !== null && typeof r.code === 'string',
    );
  } catch {
    return [];
  }
}

export async function listDisputes(opts?: {
  email?: string;
  from?: string;
  to?: string;
  status?: PabDisputeStatus;
  limit?: number;
}): Promise<{ rows: PabDayDisputeRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };

  let query = supabase.from(TABLE).select('*').order('created_at', { ascending: false });

  if (opts?.email) {
    const em = normEmail(opts.email) ?? opts.email.trim().toLowerCase();
    query = query.ilike('work_email', em);
  }
  if (opts?.from) query = query.gte('dispute_date', opts.from);
  if (opts?.to) query = query.lte('dispute_date', opts.to);
  if (opts?.status) query = query.eq('status', opts.status);
  if (opts?.limit) query = query.limit(opts.limit);

  const { data, error } = await query;
  return { rows: (data ?? []) as PabDayDisputeRow[], error: error?.message ?? null };
}

export async function getDisputeById(id: string): Promise<{
  row: PabDayDisputeRow | null;
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };

  const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
  return { row: (data as PabDayDisputeRow) ?? null, error: error?.message ?? null };
}

export async function createDispute(params: {
  work_email: string;
  dispute_date: string;
  reason: string;
  explanation?: string | null;
  created_by?: string | null;
}): Promise<{ id: string | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { id: null, error: 'Supabase not configured' };

  const codes = await getDisputeReasonCodes();
  if (codes.length > 0 && !codes.some((c) => c.code === params.reason)) {
    return { id: null, error: `Invalid reason code: ${params.reason}` };
  }

  const email = normEmail(params.work_email) ?? params.work_email.trim().toLowerCase();

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      work_email: email,
      dispute_date: params.dispute_date,
      reason: params.reason,
      explanation: params.explanation?.trim() || null,
      status: 'pending',
      created_by: params.created_by?.trim() || null,
    })
    .select('id')
    .single();

  if (error) {
    if (error.code === '23505') {
      return { id: null, error: 'A dispute already exists for this date' };
    }
    return { id: null, error: error.message };
  }

  const id = (data as { id: string } | null)?.id ?? null;

  void insertAuditLog({
    user_name: params.created_by ?? email,
    user_role: 'Employee',
    action: 'pab_dispute.submitted',
    resource: TABLE,
    resource_id: id ?? undefined,
    details: {
      employee: email,
      dispute_date: params.dispute_date,
      reason: params.reason,
    },
  });

  return { id, error: null };
}

export async function decideDispute(
  id: string,
  params: {
    status: 'approved' | 'denied';
    decided_by: string;
    decision_note?: string | null;
    override_hours?: number | null;
  },
): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };

  const { row, error: fetchErr } = await getDisputeById(id);
  if (fetchErr) return { error: fetchErr };
  if (!row) return { error: 'Dispute not found' };
  if (row.status !== 'pending') return { error: 'Dispute is no longer pending' };

  const updatePayload: Record<string, unknown> = {
    status: params.status,
    decided_by: params.decided_by.trim(),
    decided_at: new Date().toISOString(),
    decision_note: params.decision_note?.trim() || null,
    updated_at: new Date().toISOString(),
  };
  if (params.status === 'approved' && params.override_hours != null && params.override_hours > 0) {
    updatePayload.override_hours = params.override_hours;
  }

  const { error } = await supabase.from(TABLE).update(updatePayload).eq('id', id);

  if (error) return { error: error.message };

  void insertAuditLog({
    user_name: params.decided_by,
    user_role: 'Admin',
    action: params.status === 'approved' ? 'pab_dispute.approved' : 'pab_dispute.denied',
    resource: TABLE,
    resource_id: id,
    details: {
      employee: row.work_email,
      dispute_date: row.dispute_date,
      reason: row.reason,
      status: params.status,
      decided_by: params.decided_by,
      decision_note: params.decision_note ?? null,
      override_hours: params.override_hours ?? null,
    },
  });

  return { error: null };
}

export async function withdrawDispute(
  id: string,
  params: { employee_email: string },
): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };

  const { row, error: fetchErr } = await getDisputeById(id);
  if (fetchErr) return { error: fetchErr };
  if (!row) return { error: 'Dispute not found' };

  const em = normEmail(params.employee_email) ?? params.employee_email.trim().toLowerCase();
  if (normEmail(row.work_email) !== em) return { error: 'Forbidden' };
  if (row.status !== 'pending') return { error: 'Only pending disputes can be withdrawn' };

  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  if (error) return { error: error.message };

  void insertAuditLog({
    user_name: em,
    user_role: 'Employee',
    action: 'pab_dispute.withdrawn',
    resource: TABLE,
    resource_id: id,
    details: {
      employee: row.work_email,
      dispute_date: row.dispute_date,
      reason: row.reason,
    },
  });

  return { error: null };
}
