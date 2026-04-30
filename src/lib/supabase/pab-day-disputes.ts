import { createSupabaseServiceRoleClient } from './server';
import { insertAuditLog } from './audit-log';
import { getAppSetting } from './app-settings';
import { normEmail } from '@/lib/email/norm-email';
import {
  DEFAULT_DISPUTE_REASON_CODES,
  type PabDisputeReasonCode,
} from './pab-dispute-reasons';

export { DEFAULT_DISPUTE_REASON_CODES };
export type { PabDisputeReasonCode };

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

export const DISPUTE_ACTOR_ROLES: readonly string[] = [
  'payroll_coordinator',
  'finance',
  'hr_coordinator',
  'admin',
];

async function fetchActiveRoles(email: string): Promise<string[]> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('employee_roles')
    .select('role')
    .ilike('work_email', email)
    .is('revoked_at', null);
  if (error || !data) return [];
  return (data as { role: string }[]).map((r) => r.role);
}

export async function canActOnDisputes(email: string | null | undefined): Promise<boolean> {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  if (!e) return false;
  const roles = await fetchActiveRoles(e);
  return roles.some((r) => DISPUTE_ACTOR_ROLES.includes(r));
}

/**
 * Returns the primary active role for the given email, or a sensible default.
 * Priority order favours higher-privilege roles first so the audit log tag
 * reflects the decision-making authority the user acted under.
 */
export async function resolveUserRole(
  email: string | null | undefined,
  fallback: string = 'Employee',
): Promise<string> {
  if (!email) return fallback;
  const e = email.trim().toLowerCase();
  if (!e) return fallback;
  const roles = await fetchActiveRoles(e);
  if (roles.length === 0) return fallback;
  const priority = ['admin', 'finance', 'payroll_coordinator', 'hr_coordinator', 'payroll_manager'];
  for (const p of priority) {
    if (roles.includes(p)) return p;
  }
  return roles[0];
}

const TABLE = 'pab_day_disputes';

export async function getDisputeReasonCodes(): Promise<PabDisputeReasonCode[]> {
  const raw = await getAppSetting('pab_dispute_reason_codes');
  if (!raw) return DEFAULT_DISPUTE_REASON_CODES;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_DISPUTE_REASON_CODES;
    const filtered = parsed.filter(
      (r): r is PabDisputeReasonCode =>
        typeof r === 'object' && r !== null && typeof r.code === 'string',
    );
    return filtered.length > 0 ? filtered : DEFAULT_DISPUTE_REASON_CODES;
  } catch {
    return DEFAULT_DISPUTE_REASON_CODES;
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

  const submitter = params.created_by?.trim() || email;
  void (async () => {
    const role = await resolveUserRole(submitter, 'Employee');
    await insertAuditLog({
      user_name: submitter,
      user_role: role,
      action: 'pab_dispute.submitted',
      resource: TABLE,
      resource_id: id ?? undefined,
      details: {
        employee: email,
        dispute_date: params.dispute_date,
        reason: params.reason,
      },
    });
  })();

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
  // 0 is a valid SET override (zero-out the day). Only null/negative/undefined means "no override".
  const proposedOverride =
    params.override_hours != null && params.override_hours >= 0 ? params.override_hours : null;

  const { error } = await supabase.from(TABLE).update({
    status: params.status,
    decided_by: approver,
    decided_at: nowIso,
    decision_note: params.decision_note?.trim() || null,
    override_hours: params.status === 'approved' ? proposedOverride : null,
    updated_at: nowIso,
  }).eq('id', id);
  if (error) return { error: error.message };

  void (async () => {
    const role = await resolveUserRole(approverLower, 'Admin');
    await insertAuditLog({
      user_name: approver,
      user_role: role,
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
  })();
  return { error: null, stage: 'final' };
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

  const editorLower = params.decided_by.trim().toLowerCase();
  if (!(await canActOnDisputes(editorLower))) {
    return { error: 'Not authorized — only Accounting roles can edit dispute decisions' };
  }

  const { row, error: fetchErr } = await getDisputeById(id);
  if (fetchErr) return { error: fetchErr };
  if (!row) return { error: 'Dispute not found' };
  if (row.status === 'pending') return { error: 'Use decide for pending disputes' };

  const nowIso = new Date().toISOString();
  const editor = params.decided_by.trim();
  // 0 is a valid SET override (zero-out the day). Only null/negative/undefined means "no override".
  const newOverride =
    params.status === 'approved' && params.override_hours != null && params.override_hours >= 0
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

  void (async () => {
    const role = await resolveUserRole(editorLower, 'Admin');
    await insertAuditLog({
      user_name: editor,
      user_role: role,
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
  })();

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

  // Atomic upsert on the unique (work_email, dispute_date) index — avoids the
  // TOCTOU race two concurrent admins could previously trigger with check-then-insert.
  const { data, error } = await supabase
    .from(TABLE)
    .upsert(payload, { onConflict: 'work_email,dispute_date' })
    .select('id')
    .single();

  if (error) return { id: null, error: error.message };
  const id = (data as { id: string } | null)?.id ?? null;

  void (async () => {
    const role = await resolveUserRole(admin, 'Admin');
    await insertAuditLog({
      user_name: admin,
      user_role: role,
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
  })();

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

  void (async () => {
    const role = await resolveUserRole(params.admin_name, 'Admin');
    await insertAuditLog({
      user_name: params.admin_name,
      user_role: role,
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
  })();

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

  void (async () => {
    const role = await resolveUserRole(em, 'Employee');
    await insertAuditLog({
      user_name: em,
      user_role: role,
      action: 'pab_dispute.withdrawn',
      resource: TABLE,
      resource_id: id,
      details: {
        employee: row.work_email,
        dispute_date: row.dispute_date,
        reason: row.reason,
      },
    });
  })();

  return { error: null };
}
