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
  first_approved_by: string | null;
  first_approved_at: string | null;
  first_approved_note: string | null;
  first_approved_override_hours: number | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
};

export const DISPUTE_APPROVERS: readonly string[] = [
  'carla@simple.biz',
  'franm@simple.biz',
];

export function isDisputeApprover(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  return DISPUTE_APPROVERS.includes(e);
}

export const DISPUTE_ACTOR_ROLES: readonly string[] = [
  'payroll_coordinator',
  'payroll_manager',
  'finance',
  'hr_coordinator',
  'admin',
];

export async function canActOnDisputes(email: string | null | undefined): Promise<boolean> {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  if (!e) return false;
  if (DISPUTE_APPROVERS.includes(e)) return true;
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return false;
  const { data, error } = await supabase
    .from('employee_roles')
    .select('role')
    .ilike('work_email', e)
    .is('revoked_at', null);
  if (error || !data) return false;
  return data.some((r) => DISPUTE_ACTOR_ROLES.includes((r as { role: string }).role));
}

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
): Promise<{ error: string | null; stage?: 'first' | 'final' }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };

  const approver = params.decided_by.trim();
  const approverLower = approver.toLowerCase();
  if (!(await canActOnDisputes(approverLower))) {
    return { error: 'Not authorized — only Accounting roles can decide disputes' };
  }

  const { row, error: fetchErr } = await getDisputeById(id);
  if (fetchErr) return { error: fetchErr };
  if (!row) return { error: 'Dispute not found' };
  if (row.status !== 'pending') return { error: 'Dispute is no longer pending' };

  const nowIso = new Date().toISOString();
  const proposedOverride =
    params.override_hours != null && params.override_hours > 0 ? params.override_hours : null;

  const { error } = await supabase.from(TABLE).update({
    status: params.status,
    decided_by: approver,
    decided_at: nowIso,
    decision_note: params.decision_note?.trim() || null,
    override_hours: params.status === 'approved' ? proposedOverride : null,
    updated_at: nowIso,
  }).eq('id', id);
  if (error) return { error: error.message };

  void insertAuditLog({
    user_name: approver,
    user_role: 'Admin',
    action: params.status === 'approved' ? 'pab_dispute.approved' : 'pab_dispute.denied',
    resource: TABLE,
    resource_id: id,
    details: {
      employee: row.work_email,
      dispute_date: row.dispute_date,
      reason: row.reason,
      decided_by: approver,
      decision_note: params.decision_note ?? null,
      override_hours: params.status === 'approved' ? proposedOverride : null,
    },
  });
  return { error: null, stage: 'final' };
}

export async function revokeFirstApproval(
  id: string,
  params: { revoked_by: string },
): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };

  const actor = params.revoked_by.trim();
  if (!(await canActOnDisputes(actor.toLowerCase()))) {
    return { error: 'Not authorized' };
  }

  const { row, error: fetchErr } = await getDisputeById(id);
  if (fetchErr) return { error: fetchErr };
  if (!row) return { error: 'Dispute not found' };
  if (row.status !== 'pending' || !row.first_approved_by) {
    return { error: 'No first approval to revoke' };
  }
  if (row.first_approved_by.trim().toLowerCase() !== actor.toLowerCase()) {
    return { error: 'Only the first approver can revoke their own vote' };
  }

  const { error } = await supabase.from(TABLE).update({
    first_approved_by: null,
    first_approved_at: null,
    first_approved_note: null,
    first_approved_override_hours: null,
    updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) return { error: error.message };

  void insertAuditLog({
    user_name: actor, user_role: 'Admin', action: 'pab_dispute.approval_revoked',
    resource: TABLE, resource_id: id,
    details: { employee: row.work_email, dispute_date: row.dispute_date, revoked_by: actor },
  });
  return { error: null };
}

export async function editDisputeDecision(
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

  if (!(await canActOnDisputes(params.decided_by.trim().toLowerCase()))) {
    return { error: 'Not authorized — only Accounting roles can edit dispute decisions' };
  }

  const { row, error: fetchErr } = await getDisputeById(id);
  if (fetchErr) return { error: fetchErr };
  if (!row) return { error: 'Dispute not found' };
  if (row.status === 'pending') return { error: 'Use decide for pending disputes' };

  const nowIso = new Date().toISOString();
  const editor = params.decided_by.trim();
  const newOverride =
    params.status === 'approved' && params.override_hours != null && params.override_hours > 0
      ? params.override_hours
      : null;

  const { error } = await supabase
    .from(TABLE)
    .update({
      status: params.status,
      decided_by: editor,
      decided_at: nowIso,
      decision_note: params.decision_note?.trim() || null,
      override_hours: newOverride,
      updated_at: nowIso,
    })
    .eq('id', id);

  if (error) return { error: error.message };

  void insertAuditLog({
    user_name: editor,
    user_role: 'Admin',
    action: 'pab_dispute.edited',
    resource: TABLE,
    resource_id: id,
    details: {
      employee: row.work_email,
      dispute_date: row.dispute_date,
      reason: row.reason,
      previous: {
        status: row.status,
        override_hours: row.override_hours,
        decision_note: row.decision_note,
        decided_by: row.decided_by,
      },
      next: {
        status: params.status,
        override_hours: newOverride,
        decision_note: params.decision_note ?? null,
        decided_by: editor,
      },
    },
  });

  return { error: null };
}

export async function adminCreateOrphanageVisit(params: {
  work_email: string;
  visit_date: string;
  note?: string | null;
  admin_name: string;
}): Promise<{ id: string | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { id: null, error: 'Supabase not configured' };

  const email = normEmail(params.work_email) ?? params.work_email.trim().toLowerCase();
  const admin = params.admin_name.trim();
  if (!admin) return { id: null, error: 'admin_name is required' };

  const nowIso = new Date().toISOString();
  const note = params.note?.trim() || null;
  const payload = {
    work_email: email,
    dispute_date: params.visit_date,
    reason: 'orphanage_visit',
    explanation: note,
    status: 'approved' as const,
    decided_by: admin,
    decided_at: nowIso,
    decision_note: note,
    created_by: admin,
    updated_at: nowIso,
  };

  const { data: existing } = await supabase
    .from(TABLE)
    .select('id, status')
    .eq('work_email', email)
    .eq('dispute_date', params.visit_date)
    .maybeSingle();

  let id: string | null = null;
  if (existing) {
    const { error } = await supabase
      .from(TABLE)
      .update(payload)
      .eq('id', (existing as { id: string }).id);
    if (error) return { id: null, error: error.message };
    id = (existing as { id: string }).id;
  } else {
    const { data, error } = await supabase
      .from(TABLE)
      .insert(payload)
      .select('id')
      .single();
    if (error) return { id: null, error: error.message };
    id = (data as { id: string } | null)?.id ?? null;
  }

  void insertAuditLog({
    user_name: admin,
    user_role: 'Admin',
    action: 'pab_dispute.approved',
    resource: TABLE,
    resource_id: id ?? undefined,
    details: {
      employee: email,
      dispute_date: params.visit_date,
      reason: 'orphanage_visit',
      status: 'approved',
      decided_by: admin,
      decision_note: note,
      source: 'admin_orphanage_roster',
    },
  });

  return { id, error: null };
}

export async function adminDeleteOrphanageVisit(
  id: string,
  params: { admin_name: string },
): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };

  const { row, error: fetchErr } = await getDisputeById(id);
  if (fetchErr) return { error: fetchErr };
  if (!row) return { error: 'Visit not found' };
  if (row.reason !== 'orphanage_visit') return { error: 'Not an orphanage visit entry' };

  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  if (error) return { error: error.message };

  void insertAuditLog({
    user_name: params.admin_name,
    user_role: 'Admin',
    action: 'pab_dispute.withdrawn',
    resource: TABLE,
    resource_id: id,
    details: {
      employee: row.work_email,
      dispute_date: row.dispute_date,
      reason: 'orphanage_visit',
      source: 'admin_orphanage_roster',
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
