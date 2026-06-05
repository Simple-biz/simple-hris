import { createSupabaseServiceRoleClient } from './server';
import { insertAuditLog } from './audit-log';
import { canActOnDisputes, resolveUserRole } from './pab-day-disputes';
import { normEmail } from '@/lib/email/norm-email';
import { listDepartmentsForManager } from './department-managers';

/**
 * Time Adjustment Requests — employee-initiated, evidence-backed requests for Accounting
 * to correct a day's tracked hours. Approval writes `approved_hours`, a SET-semantics
 * override the pay calc overlays at calc time. This module NEVER mutates hubstaff_hours.
 */

export const TIME_ADJUSTMENT_BUCKET = 'time-adjustment-evidence';
export const MAX_ADJUSTMENT_IMAGES = 5;

const TABLE = 'time_adjustment_requests';

/**
 * Status lifecycle:
 *   pending -> manager_approved | manager_denied
 *   manager_approved -> approved | denied   (accounting step)
 */
export type TimeAdjustmentStatus =
  | 'pending'
  | 'manager_approved'
  | 'manager_denied'
  | 'approved'
  | 'denied';

export type TimeAdjustmentRow = {
  id: string;
  work_email: string;
  adjust_date: string;
  reason: string;
  explanation: string | null;
  requested_hours: number | null;
  image_paths: string[];
  status: TimeAdjustmentStatus;
  approved_hours: number | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  manager_decided_by: string | null;
  manager_decided_at: string | null;
  manager_decision_note: string | null;
  period_label: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
};

export function adjustmentIsAwaitingManager(row: Pick<TimeAdjustmentRow, 'status'>): boolean {
  return row.status === 'pending';
}

export function adjustmentIsAwaitingAccounting(row: Pick<TimeAdjustmentRow, 'status'>): boolean {
  return row.status === 'manager_approved';
}

export function adjustmentIsFinallyDecided(row: Pick<TimeAdjustmentRow, 'status'>): boolean {
  return row.status === 'approved' || row.status === 'denied' || row.status === 'manager_denied';
}

export type TimeAdjustmentReasonCode = { code: string; label: string };

/** Built-in reasons. ASCII-only labels. `other` requires an explanation. */
export const TIME_ADJUSTMENT_REASONS: readonly TimeAdjustmentReasonCode[] = [
  { code: 'forgot_tracker', label: 'Forgot to start Hubstaff tracker' },
  { code: 'tracker_crashed', label: 'Tracker crashed / technical glitch (time not recorded)' },
  { code: 'worked_offline', label: 'Worked offline or untracked (meetings, calls, on-site)' },
  { code: 'other', label: 'Other' },
];

export function isValidAdjustmentReason(code: string): boolean {
  return TIME_ADJUSTMENT_REASONS.some((r) => r.code === code);
}

/** YYYY-MM period stamp for the supplied (or current) date. */
function periodLabelFor(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export async function listTimeAdjustments(opts?: {
  email?: string;
  from?: string;
  to?: string;
  status?: TimeAdjustmentStatus;
  statuses?: TimeAdjustmentStatus[];
  limit?: number;
}): Promise<{ rows: TimeAdjustmentRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };

  let query = supabase.from(TABLE).select('*').order('created_at', { ascending: false });

  if (opts?.email) {
    const em = normEmail(opts.email) ?? opts.email.trim().toLowerCase();
    query = query.ilike('work_email', em);
  }
  if (opts?.from) query = query.gte('adjust_date', opts.from);
  if (opts?.to) query = query.lte('adjust_date', opts.to);
  if (opts?.statuses && opts.statuses.length > 0) {
    query = query.in('status', opts.statuses);
  } else if (opts?.status) {
    query = query.eq('status', opts.status);
  }
  if (opts?.limit) query = query.limit(opts.limit);

  const { data, error } = await query;
  return { rows: (data ?? []) as TimeAdjustmentRow[], error: error?.message ?? null };
}

export async function getTimeAdjustmentById(id: string): Promise<{
  row: TimeAdjustmentRow | null;
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };
  const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
  return { row: (data as TimeAdjustmentRow) ?? null, error: error?.message ?? null };
}

export async function createTimeAdjustment(params: {
  work_email: string;
  adjust_date: string;
  reason: string;
  explanation?: string | null;
  requested_hours?: number | null;
  image_paths?: string[];
  created_by?: string | null;
}): Promise<{ id: string | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { id: null, error: 'Supabase not configured' };

  if (!isValidAdjustmentReason(params.reason)) {
    return { id: null, error: `Invalid reason code: ${params.reason}` };
  }

  const email = normEmail(params.work_email) ?? params.work_email.trim().toLowerCase();
  const paths = (params.image_paths ?? []).filter(Boolean).slice(0, MAX_ADJUSTMENT_IMAGES);
  const reqHours =
    params.requested_hours != null && params.requested_hours >= 0 ? params.requested_hours : null;
  const nowIso = new Date().toISOString();

  // Upsert on (work_email, adjust_date) so a re-request for the same day overwrites the
  // prior PENDING row rather than failing the unique index. Decided rows are protected below.
  const { row: existing } = await getTimeAdjustmentByEmailDate(email, params.adjust_date);
  if (existing && existing.status !== 'pending') {
    return { id: null, error: 'A decided request already exists for this date' };
  }

  const payload = {
    work_email: email,
    adjust_date: params.adjust_date,
    reason: params.reason,
    explanation: params.explanation?.trim() || null,
    requested_hours: reqHours,
    image_paths: paths,
    status: 'pending' as const,
    period_label: periodLabelFor(new Date()),
    created_by: params.created_by?.trim() || null,
    updated_at: nowIso,
  };

  const { data, error } = await supabase
    .from(TABLE)
    .upsert(payload, { onConflict: 'work_email,adjust_date' })
    .select('id')
    .single();

  if (error) return { id: null, error: error.message };
  const id = (data as { id: string } | null)?.id ?? null;

  const submitter = params.created_by?.trim() || email;
  void (async () => {
    const role = await resolveUserRole(submitter, 'Employee');
    await insertAuditLog({
      user_name: submitter,
      user_role: role,
      action: 'time_adjustment.submitted',
      resource: TABLE,
      resource_id: id ?? undefined,
      details: { employee: email, adjust_date: params.adjust_date, reason: params.reason },
    });
  })();

  return { id, error: null };
}

async function getTimeAdjustmentByEmailDate(
  email: string,
  date: string,
): Promise<{ row: TimeAdjustmentRow | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null };
  const { data } = await supabase
    .from(TABLE)
    .select('*')
    .ilike('work_email', email)
    .eq('adjust_date', date)
    .maybeSingle();
  return { row: (data as TimeAdjustmentRow) ?? null };
}

/**
 * Manager decision (stage 1). Requires the caller to manage the employee's department.
 * Moves status from `pending` -> `manager_approved` | `manager_denied`.
 */
export async function managerDecideTimeAdjustment(
  id: string,
  params: {
    action: 'manager_approve' | 'manager_deny';
    decided_by: string;
    decision_note?: string | null;
  },
): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };

  const manager = params.decided_by.trim();
  const managerLower = manager.toLowerCase();

  const { row, error: fetchErr } = await getTimeAdjustmentById(id);
  if (fetchErr) return { error: fetchErr };
  if (!row) return { error: 'Request not found' };
  if (row.status !== 'pending') return { error: 'Request is no longer pending manager review' };

  // Verify the manager oversees this employee's department.
  const { rows: deptAssigns } = await listDepartmentsForManager(managerLower);
  if (deptAssigns.length === 0) {
    return { error: 'Not authorized — no department assignments found for this manager' };
  }
  const managedDepts = deptAssigns.map((a) => a.department.trim().toLowerCase());

  // Look up the employee's department from global_master_list.
  const { data: masterData } = await supabase
    .from('active_employees')
    .select('"Department"')
    .ilike('"Work Email"', row.work_email)
    .maybeSingle();
  const empDept = ((masterData as Record<string, unknown> | null)?.['Department'] as string | null)
    ?.trim()
    .toLowerCase() ?? '';
  if (!empDept || !managedDepts.includes(empDept)) {
    return { error: 'Not authorized — employee is not in your managed departments' };
  }

  const nextStatus: TimeAdjustmentStatus =
    params.action === 'manager_approve' ? 'manager_approved' : 'manager_denied';
  const nowIso = new Date().toISOString();

  const { error } = await supabase
    .from(TABLE)
    .update({
      status: nextStatus,
      manager_decided_by: manager,
      manager_decided_at: nowIso,
      manager_decision_note: params.decision_note?.trim() || null,
      updated_at: nowIso,
    })
    .eq('id', id);
  if (error) return { error: error.message };

  void (async () => {
    const role = await resolveUserRole(managerLower, 'Manager');
    await insertAuditLog({
      user_name: manager,
      user_role: role,
      action: params.action === 'manager_approve'
        ? 'time_adjustment.manager_approved'
        : 'time_adjustment.manager_denied',
      resource: TABLE,
      resource_id: id,
      details: {
        employee: row.work_email,
        adjust_date: row.adjust_date,
        decision_note: params.decision_note ?? null,
      },
    });
  })();

  return { error: null };
}

/**
 * Manager recall. Pulls a request the manager already forwarded back out of Accounting
 * and into the manager's pending queue for a second review. Moves status from
 * `manager_approved` -> `pending` and clears BOTH decision sets plus any approved-hours
 * override, so the request is re-reviewed from scratch. Requires the caller to manage the
 * employee's department.
 */
export async function recallTimeAdjustment(
  id: string,
  params: {
    recalled_by: string;
    decision_note?: string | null;
  },
): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };

  const manager = params.recalled_by.trim();
  const managerLower = manager.toLowerCase();

  const { row, error: fetchErr } = await getTimeAdjustmentById(id);
  if (fetchErr) return { error: fetchErr };
  if (!row) return { error: 'Request not found' };
  if (row.status !== 'manager_approved') {
    return { error: 'Only requests forwarded to Accounting can be recalled' };
  }

  // Verify the manager oversees this employee's department.
  const { rows: deptAssigns } = await listDepartmentsForManager(managerLower);
  if (deptAssigns.length === 0) {
    return { error: 'Not authorized — no department assignments found for this manager' };
  }
  const managedDepts = deptAssigns.map((a) => a.department.trim().toLowerCase());

  const { data: masterData } = await supabase
    .from('active_employees')
    .select('"Department"')
    .ilike('"Work Email"', row.work_email)
    .maybeSingle();
  const empDept = ((masterData as Record<string, unknown> | null)?.['Department'] as string | null)
    ?.trim()
    .toLowerCase() ?? '';
  if (!empDept || !managedDepts.includes(empDept)) {
    return { error: 'Not authorized — employee is not in your managed departments' };
  }

  const nowIso = new Date().toISOString();

  const { error } = await supabase
    .from(TABLE)
    .update({
      status: 'pending' as const,
      // Clear both decision sets and the payroll override so the request restarts clean.
      manager_decided_by: null,
      manager_decided_at: null,
      manager_decision_note: null,
      decided_by: null,
      decided_at: null,
      decision_note: null,
      approved_hours: null,
      updated_at: nowIso,
    })
    .eq('id', id);
  if (error) return { error: error.message };

  void (async () => {
    const role = await resolveUserRole(managerLower, 'Manager');
    await insertAuditLog({
      user_name: manager,
      user_role: role,
      action: 'time_adjustment.recalled',
      resource: TABLE,
      resource_id: id,
      details: {
        employee: row.work_email,
        adjust_date: row.adjust_date,
        decision_note: params.decision_note ?? null,
      },
    });
  })();

  return { error: null };
}

/**
 * Accounting decision (stage 2). Requires `manager_approved` status and an accounting role.
 * Moves status from `manager_approved` -> `approved` | `denied`.
 */
export async function decideTimeAdjustment(
  id: string,
  params: {
    status: 'approved' | 'denied';
    decided_by: string;
    approved_hours?: number | null;
    decision_note?: string | null;
  },
): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };

  const approver = params.decided_by.trim();
  const approverLower = approver.toLowerCase();
  if (!(await canActOnDisputes(approverLower))) {
    return { error: 'Not authorized — only Accounting roles can decide time adjustments' };
  }

  const { row, error: fetchErr } = await getTimeAdjustmentById(id);
  if (fetchErr) return { error: fetchErr };
  if (!row) return { error: 'Request not found' };
  if (row.status !== 'manager_approved') {
    return { error: 'Request must be approved by a manager before Accounting can act on it' };
  }

  const nowIso = new Date().toISOString();
  // 0 is a valid SET override (zero the day). Only null/negative/undefined means "no override".
  const override =
    params.status === 'approved' && params.approved_hours != null && params.approved_hours >= 0
      ? params.approved_hours
      : null;

  const { error } = await supabase
    .from(TABLE)
    .update({
      status: params.status,
      approved_hours: override,
      decided_by: approver,
      decided_at: nowIso,
      decision_note: params.decision_note?.trim() || null,
      updated_at: nowIso,
    })
    .eq('id', id);
  if (error) return { error: error.message };

  void (async () => {
    const role = await resolveUserRole(approverLower, 'Admin');
    await insertAuditLog({
      user_name: approver,
      user_role: role,
      action: params.status === 'approved' ? 'time_adjustment.approved' : 'time_adjustment.denied',
      resource: TABLE,
      resource_id: id,
      details: {
        employee: row.work_email,
        adjust_date: row.adjust_date,
        approved_hours: override,
        decision_note: params.decision_note ?? null,
      },
    });
  })();

  return { error: null };
}

/**
 * Accounting-only hard delete. Only allowed when status is `denied` or `manager_denied`.
 * Caller must hold an active accounting role.
 */
export async function deleteTimeAdjustment(
  id: string,
  actorEmail: string,
): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };

  const actorLower = actorEmail.trim().toLowerCase();
  if (!(await canActOnDisputes(actorLower))) {
    return { error: 'Not authorized — only Accounting roles can delete time adjustments' };
  }

  const { row, error: fetchErr } = await getTimeAdjustmentById(id);
  if (fetchErr) return { error: fetchErr };
  if (!row) return { error: 'Request not found' };
  if (row.status !== 'denied' && row.status !== 'manager_denied') {
    return { error: 'Only denied requests can be deleted' };
  }

  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  if (error) return { error: error.message };

  void (async () => {
    const role = await resolveUserRole(actorLower, 'Admin');
    await insertAuditLog({
      user_name: actorLower,
      user_role: role,
      action: 'time_adjustment.deleted',
      resource: TABLE,
      resource_id: id,
      details: { employee: row.work_email, adjust_date: row.adjust_date, prior_status: row.status },
    });
  })();

  return { error: null };
}

/**
 * Uploads one evidence image to the private bucket. Returns the object PATH (not a URL).
 * Path: <sanitized-email>/<requestKey>/<idx>-<ts>.<ext>
 */
export async function uploadTimeAdjustmentImage(
  requestKey: string,
  email: string,
  bytes: ArrayBuffer,
  contentType: string,
  idx: number,
  ext: string,
): Promise<{ path: string | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { path: null, error: 'Supabase not configured' };

  const safeEmail = (email || 'unknown').toLowerCase().replace(/[^a-z0-9._-]/g, '_');
  const safeExt = (ext || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const path = `${safeEmail}/${requestKey}/${idx}-${Date.now()}.${safeExt}`;

  const { error } = await supabase.storage
    .from(TIME_ADJUSTMENT_BUCKET)
    .upload(path, bytes, { contentType, upsert: false });
  if (error) return { path: null, error: error.message };
  return { path, error: null };
}

/** Batch sign object paths for the Accounting review view. 1-hour expiry. */
export async function signTimeAdjustmentImageUrls(
  paths: string[],
): Promise<Record<string, string>> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase || paths.length === 0) return {};
  const out: Record<string, string> = {};
  const { data, error } = await supabase.storage
    .from(TIME_ADJUSTMENT_BUCKET)
    .createSignedUrls(paths, 3600);
  if (error || !data) return {};
  for (const entry of data) {
    if (entry.path && entry.signedUrl) out[entry.path] = entry.signedUrl;
  }
  return out;
}
