import { createSupabaseServiceRoleClient } from './server';
import { insertAuditLog } from './audit-log';
import { canActOnDisputes, resolveUserRole } from './pab-day-disputes';
import { normEmail } from '@/lib/email/norm-email';
import { overrideDeptLabel } from '@/lib/departments/dept-email-overrides';
import { listDepartmentsForManager } from './department-managers';

/**
 * Time Adjustment Requests — employee-initiated, evidence-backed requests for Accounting
 * to correct a day's tracked hours. Approval writes `approved_hours`, a SET-semantics
 * override the pay calc overlays at calc time. This module NEVER mutates hubstaff_hours.
 */

export const TIME_ADJUSTMENT_BUCKET = 'time-adjustment-evidence';
export const MAX_ADJUSTMENT_IMAGES = 5;
export const MAX_ADJUSTMENT_SEGMENTS = 6;

const TABLE = 'time_adjustment_requests';

/**
 * One MISSED (untracked) time range within the adjusted day. 24h "HH:MM", day-local.
 * Segments are only the time to be ADDED on top of tracked hours — not the full shift.
 */
export type TimeAdjustmentSegment = { time_in: string; time_out: string };

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function hhmmToMinutes(v: string): number | null {
  const m = HHMM_RE.exec(v);
  if (!m) return null;
  return parseInt(m[1]!, 10) * 60 + parseInt(m[2]!, 10);
}

/**
 * Validate + normalize employee-supplied segments. Requires at least one segment;
 * each needs valid HH:MM stamps with time_out after time_in; segments may not
 * overlap. Returns the segments sorted by time_in, or an error message.
 */
export function sanitizeAdjustmentSegments(
  input: unknown,
): { segments: TimeAdjustmentSegment[] | null; error: string | null } {
  if (!Array.isArray(input) || input.length === 0) {
    return { segments: null, error: 'At least one time in / time out is required' };
  }
  if (input.length > MAX_ADJUSTMENT_SEGMENTS) {
    return { segments: null, error: `At most ${MAX_ADJUSTMENT_SEGMENTS} time ranges` };
  }
  const parsed: Array<TimeAdjustmentSegment & { inMin: number; outMin: number }> = [];
  for (const raw of input) {
    const seg = raw as Partial<TimeAdjustmentSegment> | null;
    const timeIn = typeof seg?.time_in === 'string' ? seg.time_in.trim() : '';
    const timeOut = typeof seg?.time_out === 'string' ? seg.time_out.trim() : '';
    const inMin = hhmmToMinutes(timeIn);
    const outMin = hhmmToMinutes(timeOut);
    if (inMin == null || outMin == null) {
      return { segments: null, error: 'Each time range needs a valid time in and time out (HH:MM)' };
    }
    if (outMin <= inMin) {
      return { segments: null, error: 'Time out must be after time in for each range' };
    }
    parsed.push({ time_in: timeIn, time_out: timeOut, inMin, outMin });
  }
  parsed.sort((a, b) => a.inMin - b.inMin);
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i]!.inMin < parsed[i - 1]!.outMin) {
      return { segments: null, error: 'Time ranges must not overlap' };
    }
  }
  return {
    segments: parsed.map(({ time_in, time_out }) => ({ time_in, time_out })),
    error: null,
  };
}

/** Total decimal hours covered by the segments. Invalid entries count as 0. */
export function adjustmentSegmentsTotalHours(segments: TimeAdjustmentSegment[]): number {
  let minutes = 0;
  for (const s of segments) {
    const inMin = hhmmToMinutes(s.time_in);
    const outMin = hhmmToMinutes(s.time_out);
    if (inMin != null && outMin != null && outMin > inMin) minutes += outMin - inMin;
  }
  return minutes / 60;
}

/** "09:00" -> "9:00 AM" for display. Falls back to the raw string. */
export function fmtAdjustmentClock(hhmm: string): string {
  const min = hhmmToMinutes(hhmm);
  if (min == null) return hhmm;
  const h24 = Math.floor(min / 60);
  const m = min % 60;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** "9:00 AM - 11:30 AM, 1:00 PM - 3:00 PM" summary line for reviewer views. */
export function fmtAdjustmentSegments(segments: TimeAdjustmentSegment[]): string {
  return segments
    .map((s) => `${fmtAdjustmentClock(s.time_in)} - ${fmtAdjustmentClock(s.time_out)}`)
    .join(', ');
}

/**
 * Status lifecycle (dual approval, 2026-08-19):
 *   pending                  -> manager has not decided yet
 *   awaiting_second_approval -> manager approved; the named second approver has not
 *   manager_approved         -> BOTH approved; Accounting can act
 *   manager_denied           -> EITHER party denied (terminal; blocks the adjustment)
 *   manager_approved -> approved | denied   (accounting step, unchanged)
 *
 * `status` is DERIVED from the two decisions by {@link deriveAdjustmentStatus} — never
 * written by hand — so the two sign-offs can land in either order.
 */
export type TimeAdjustmentStatus =
  | 'pending'
  | 'awaiting_second_approval'
  | 'manager_approved'
  | 'manager_denied'
  | 'approved'
  | 'denied';

/** One party's sign-off. `null` means that party has not decided yet. */
export type ApprovalDecision = 'approved' | 'denied';

/**
 * The single rule turning the two independent sign-offs into the row's status.
 * Pure and order-independent — the manager and the second approver may act in
 * either sequence and the same inputs always yield the same status.
 *
 * Precedence, highest first:
 *  1. EITHER denial is terminal and blocks the adjustment (`manager_denied`).
 *  2. No manager approval yet => `pending`, whatever the second approver did.
 *  3. No second approver named => legacy single-approval row => `manager_approved`.
 *  4. Both approved => `manager_approved`; else => `awaiting_second_approval`.
 *
 * Note (3) exists only for rows created before dual approval shipped; the write
 * paths below refuse to approve a new row without a named second approver.
 */
export function deriveAdjustmentStatus(params: {
  managerDecision: ApprovalDecision | null;
  secondDecision: ApprovalDecision | null;
  secondApproverEmail: string | null;
}): TimeAdjustmentStatus {
  const { managerDecision, secondDecision, secondApproverEmail } = params;
  // A denial from either party ends the request. Deliberately reuses the existing
  // terminal status so every downstream reader (Accounting's decided list, the
  // employee's status card, delete-eligibility) keeps working unchanged.
  if (managerDecision === 'denied' || secondDecision === 'denied') return 'manager_denied';
  if (managerDecision !== 'approved') return 'pending';
  if (!secondApproverEmail) return 'manager_approved';
  return secondDecision === 'approved' ? 'manager_approved' : 'awaiting_second_approval';
}

export type TimeAdjustmentRow = {
  id: string;
  work_email: string;
  adjust_date: string;
  reason: string;
  explanation: string | null;
  requested_hours: number | null;
  requested_segments: TimeAdjustmentSegment[];
  image_paths: string[];
  status: TimeAdjustmentStatus;
  approved_hours: number | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  manager_decided_by: string | null;
  manager_decided_at: string | null;
  manager_decision_note: string | null;
  /** The manager's explicit sign-off. Null until they act. */
  manager_decision: ApprovalDecision | null;
  /** Second approver named by the manager for THIS request (2026-08-19). */
  second_approver_email: string | null;
  second_approver_assigned_by: string | null;
  second_approver_assigned_at: string | null;
  second_decision: ApprovalDecision | null;
  second_decided_by: string | null;
  second_decided_at: string | null;
  second_decision_note: string | null;
  period_label: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
};

/** Rows the DEPARTMENT MANAGER still owes a decision on. */
export function adjustmentIsAwaitingManager(
  row: Pick<TimeAdjustmentRow, 'status' | 'manager_decision'>,
): boolean {
  return row.status === 'pending' && row.manager_decision == null;
}

/**
 * Rows the NAMED SECOND APPROVER still owes a decision on. Driven by the
 * assignment, not by status: the second approver may act first, while the row is
 * still `pending` because the manager has not.
 */
export function adjustmentIsAwaitingSecondApprover(
  row: Pick<TimeAdjustmentRow, 'status' | 'second_approver_email' | 'second_decision'>,
): boolean {
  if (!row.second_approver_email || row.second_decision != null) return false;
  return row.status === 'pending' || row.status === 'awaiting_second_approval';
}

/** True when `email` is the person this row is waiting on for a second sign-off. */
export function adjustmentAwaitsSecondApprovalFrom(
  row: Pick<TimeAdjustmentRow, 'status' | 'second_approver_email' | 'second_decision'>,
  email: string | null | undefined,
): boolean {
  const me = (email ?? '').trim().toLowerCase();
  if (!me) return false;
  return (
    adjustmentIsAwaitingSecondApprover(row) &&
    (row.second_approver_email ?? '').trim().toLowerCase() === me
  );
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
  requested_segments: TimeAdjustmentSegment[];
  image_paths?: string[];
  created_by?: string | null;
}): Promise<{ id: string | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { id: null, error: 'Supabase not configured' };

  if (!isValidAdjustmentReason(params.reason)) {
    return { id: null, error: `Invalid reason code: ${params.reason}` };
  }

  // Segments (the missed time ranges) are the source of truth; requested_hours is the
  // sum of them = the hours the employee claims should be ADDED to the day.
  const { segments, error: segError } = sanitizeAdjustmentSegments(params.requested_segments);
  if (segError || !segments) return { id: null, error: segError ?? 'Invalid time ranges' };

  const email = normEmail(params.work_email) ?? params.work_email.trim().toLowerCase();
  const paths = (params.image_paths ?? []).filter(Boolean).slice(0, MAX_ADJUSTMENT_IMAGES);
  const reqHours = adjustmentSegmentsTotalHours(segments);
  const nowIso = new Date().toISOString();

  // Upsert on (work_email, adjust_date) so editing/re-requesting the same day overwrites
  // the prior PENDING row rather than failing the unique index. Once a manager or
  // Accounting has acted, the row is locked against employee edits.
  const { row: existing } = await getTimeAdjustmentByEmailDate(email, params.adjust_date);
  // Locked once ANY reviewer has signed off — not merely once the status left `pending`.
  // Under dual approval a row stays `pending` after the second approver approves (the
  // manager still owes a decision), and letting the employee rewrite it then would apply
  // a recorded sign-off to content nobody with that sign-off ever saw.
  if (
    existing &&
    (existing.status !== 'pending' ||
      existing.manager_decision != null ||
      existing.second_decision != null)
  ) {
    return { id: null, error: 'This day\'s request has already been reviewed and can no longer be changed' };
  }

  const payload = {
    work_email: email,
    adjust_date: params.adjust_date,
    reason: params.reason,
    explanation: params.explanation?.trim() || null,
    requested_hours: reqHours,
    requested_segments: segments,
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
      details: {
        employee: email,
        adjust_date: params.adjust_date,
        reason: params.reason,
        // True when the employee edited a still-pending request (row overwritten).
        resubmission: !!existing,
      },
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
 * Shared department-scope check for the MANAGER stage: does `managerEmail` manage the
 * department the request's employee belongs to? Used by manager decide / recall /
 * second-approver assignment so the three can never drift apart.
 *
 * Note this is the manager's authorization only. The named second approver is
 * authorized by the assignment on the row itself (see {@link secondDecideTimeAdjustment}),
 * which is ADDITIVE to this check — it never relaxes it.
 */
async function authorizeManagerOverAdjustment(
  supabase: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>,
  managerEmail: string,
  workEmail: string,
): Promise<{ error: string | null }> {
  const { rows: deptAssigns } = await listDepartmentsForManager(managerEmail);
  if (deptAssigns.length === 0) {
    return { error: 'Not authorized — no department assignments found for this manager' };
  }
  const managedDepts = deptAssigns.map((a) => a.department.trim().toLowerCase());

  // Look up the employee's department from global_master_list.
  const { data: masterData } = await supabase
    .from('active_employees')
    .select('"Department"')
    .ilike('"Work Email"', workEmail)
    .maybeSingle();
  // Effective department (Sales/Sales-Assistant email split) so the right
  // department's manager is authorized over the request.
  const empDept = (
    overrideDeptLabel(
      (masterData as Record<string, unknown> | null)?.['Department'] as string | null,
      workEmail,
    ) ?? ''
  )
    .trim()
    .toLowerCase();
  if (!empDept || !managedDepts.includes(empDept)) {
    return { error: 'Not authorized — employee is not in your managed departments' };
  }
  return { error: null };
}

/**
 * Names (or re-names) the second approver for a request. Manager-scoped: the caller
 * must manage the employee's department. Only allowed while the request is still open
 * and the current second approver has NOT already decided — re-pointing a request away
 * from someone who already signed off would discard a recorded decision.
 */
export async function assignSecondApprover(
  id: string,
  params: { second_approver_email: string; assigned_by: string },
): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };

  const manager = params.assigned_by.trim();
  const managerLower = manager.toLowerCase();
  const approver = normEmail(params.second_approver_email) ?? params.second_approver_email.trim().toLowerCase();
  if (!approver) return { error: 'A second approver is required' };

  const { row, error: fetchErr } = await getTimeAdjustmentById(id);
  if (fetchErr) return { error: fetchErr };
  if (!row) return { error: 'Request not found' };
  if (row.status !== 'pending' && row.status !== 'awaiting_second_approval') {
    return { error: 'Request is no longer open for review' };
  }
  if (row.second_decision != null) {
    return { error: 'The second approver has already decided — recall the request to start over' };
  }
  // Two sign-offs must come from two people, and neither may be the employee whose
  // hours are being corrected.
  if (approver === managerLower) {
    return { error: 'Pick someone other than yourself as the second approver' };
  }
  if (approver === row.work_email.trim().toLowerCase()) {
    return { error: 'The employee who filed the request cannot approve it' };
  }

  const authErr = await authorizeManagerOverAdjustment(supabase, managerLower, row.work_email);
  if (authErr.error) return authErr;

  // The named person must actually be able to reach and act on the queue, or the
  // request would be parked forever waiting on someone who can never sign off.
  // Fails CLOSED: an unreadable eligibility list rejects rather than admits.
  const eligible = await listSecondApproverCandidates();
  if (eligible.error) return { error: `Could not verify second approver eligibility: ${eligible.error}` };
  if (!eligible.emails.includes(approver)) {
    return {
      error: 'That person cannot approve time adjustments — an admin must grant them Manager access first',
    };
  }

  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from(TABLE)
    .update({
      second_approver_email: approver,
      second_approver_assigned_by: manager,
      second_approver_assigned_at: nowIso,
      updated_at: nowIso,
    })
    .eq('id', id);
  if (error) return { error: error.message };

  void (async () => {
    const role = await resolveUserRole(managerLower, 'Manager');
    await insertAuditLog({
      user_name: manager,
      user_role: role,
      action: 'time_adjustment.second_approver_assigned',
      resource: TABLE,
      resource_id: id,
      details: {
        employee: row.work_email,
        adjust_date: row.adjust_date,
        second_approver: approver,
        previous_second_approver: row.second_approver_email ?? null,
      },
    });
  })();

  return { error: null };
}

/**
 * Manager decision (stage 1 of 2). Requires the caller to manage the employee's
 * department. Records the manager's sign-off; the resulting status is DERIVED, so
 * approving only reaches Accounting once the named second approver has also approved.
 *
 * Approving requires a second approver to be named (`second_approver_email`) — the
 * dual-approval rule. Denying does not: a denial is terminal on its own.
 */
export async function managerDecideTimeAdjustment(
  id: string,
  params: {
    action: 'manager_approve' | 'manager_deny';
    decided_by: string;
    decision_note?: string | null;
    /** Optional: name the second approver in the same call as the approval. */
    second_approver_email?: string | null;
  },
): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };

  const manager = params.decided_by.trim();
  const managerLower = manager.toLowerCase();

  // Name the second approver first when the caller supplied one, so the decision
  // below derives against the final assignment. assignSecondApprover runs the same
  // department check, so an unauthorized caller is rejected before anything is written.
  if (params.action === 'manager_approve' && params.second_approver_email) {
    const assigned = await assignSecondApprover(id, {
      second_approver_email: params.second_approver_email,
      assigned_by: manager,
    });
    if (assigned.error) return assigned;
  }

  const { row, error: fetchErr } = await getTimeAdjustmentById(id);
  if (fetchErr) return { error: fetchErr };
  if (!row) return { error: 'Request not found' };
  if (row.manager_decision != null) return { error: 'You have already decided this request' };
  if (row.status !== 'pending') return { error: 'Request is no longer pending manager review' };

  const authErr = await authorizeManagerOverAdjustment(supabase, managerLower, row.work_email);
  if (authErr.error) return authErr;

  // Dual approval: forwarding to Accounting takes two sign-offs, so an approval
  // without a named second approver has nobody to countersign it.
  if (params.action === 'manager_approve' && !row.second_approver_email) {
    return { error: 'Select a second approver before approving this request' };
  }

  const managerDecision: ApprovalDecision =
    params.action === 'manager_approve' ? 'approved' : 'denied';
  const nextStatus = deriveAdjustmentStatus({
    managerDecision,
    secondDecision: row.second_decision,
    secondApproverEmail: row.second_approver_email,
  });
  const nowIso = new Date().toISOString();

  const { error } = await supabase
    .from(TABLE)
    .update({
      status: nextStatus,
      manager_decision: managerDecision,
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
        second_approver: row.second_approver_email ?? null,
        resulting_status: nextStatus,
      },
    });
  })();

  return { error: null };
}

/**
 * Second-approver decision (the other half of stage 1). Authorized by the ASSIGNMENT on
 * the row — `second_approver_email` must be the caller — which is what lets an approver
 * from another department sign off. This is ADDITIVE to the manager's department check,
 * never a replacement: the manager path still requires department scope.
 *
 * Order-independent: the second approver may decide before or after the manager. The
 * resulting status is derived, so an approval only reaches Accounting once both have
 * approved, and either denial is terminal.
 */
export async function secondDecideTimeAdjustment(
  id: string,
  params: {
    action: 'second_approve' | 'second_deny';
    decided_by: string;
    decision_note?: string | null;
  },
): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };

  const approver = params.decided_by.trim();
  const approverLower = approver.toLowerCase();

  const { row, error: fetchErr } = await getTimeAdjustmentById(id);
  if (fetchErr) return { error: fetchErr };
  if (!row) return { error: 'Request not found' };

  // The assignment IS the authorization. No assignment, no access.
  const named = (row.second_approver_email ?? '').trim().toLowerCase();
  if (!named || named !== approverLower) {
    return { error: 'Not authorized — you are not the second approver for this request' };
  }
  if (row.second_decision != null) return { error: 'You have already decided this request' };
  if (row.status !== 'pending' && row.status !== 'awaiting_second_approval') {
    return { error: 'Request is no longer open for review' };
  }

  const secondDecision: ApprovalDecision =
    params.action === 'second_approve' ? 'approved' : 'denied';
  const nextStatus = deriveAdjustmentStatus({
    managerDecision: row.manager_decision,
    secondDecision,
    secondApproverEmail: row.second_approver_email,
  });
  const nowIso = new Date().toISOString();

  const { error } = await supabase
    .from(TABLE)
    .update({
      status: nextStatus,
      second_decision: secondDecision,
      second_decided_by: approver,
      second_decided_at: nowIso,
      second_decision_note: params.decision_note?.trim() || null,
      updated_at: nowIso,
    })
    .eq('id', id);
  if (error) return { error: error.message };

  void (async () => {
    const role = await resolveUserRole(approverLower, 'Manager');
    await insertAuditLog({
      user_name: approver,
      user_role: role,
      action: params.action === 'second_approve'
        ? 'time_adjustment.second_approved'
        : 'time_adjustment.second_denied',
      resource: TABLE,
      resource_id: id,
      details: {
        employee: row.work_email,
        adjust_date: row.adjust_date,
        decision_note: params.decision_note ?? null,
        assigned_by: row.second_approver_assigned_by ?? null,
        resulting_status: nextStatus,
      },
    });
  })();

  return { error: null };
}

/**
 * Everyone who may be named as a second approver: people who ALREADY hold Manager
 * dashboard access. Deliberately NOT "any employee" — naming someone confers no access
 * (granting access stays admin-only, `rbac-feature-permissions.md:66`), so the pool can
 * only contain people an admin already provisioned.
 *
 * Eligible = an active `admin` role (bypasses feature gating everywhere), OR an active
 * `manager` role AND an `edit` grant on manager/time_adjustments. `edit` specifically,
 * because `view` cannot mutate — naming a view-only person would park the request
 * forever on someone who can never sign off.
 */
export async function listSecondApproverCandidates(): Promise<{
  emails: string[];
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { emails: [], error: 'Supabase not configured' };

  const { data: roleRows, error: roleErr } = await supabase
    .from('employee_roles')
    .select('work_email, role')
    .is('revoked_at', null)
    .in('role', ['manager', 'admin']);
  if (roleErr) return { emails: [], error: roleErr.message };

  const admins = new Set<string>();
  const managers = new Set<string>();
  for (const r of (roleRows ?? []) as Array<{ work_email: string; role: string }>) {
    const em = (r.work_email ?? '').trim().toLowerCase();
    if (!em) continue;
    if (r.role === 'admin') admins.add(em);
    else if (r.role === 'manager') managers.add(em);
  }

  const { data: permRows, error: permErr } = await supabase
    .from('employee_feature_permissions')
    .select('work_email, access')
    .eq('view_key', 'manager')
    .eq('feature', 'time_adjustments')
    .eq('access', 'edit')
    .is('revoked_at', null);
  if (permErr) return { emails: [], error: permErr.message };

  const out = new Set<string>(admins);
  for (const p of (permRows ?? []) as Array<{ work_email: string }>) {
    const em = (p.work_email ?? '').trim().toLowerCase();
    if (em && managers.has(em)) out.add(em);
  }

  return { emails: [...out].sort(), error: null };
}

/**
 * Manager recall. Pulls a request the manager already forwarded back out of Accounting
 * and into the manager's pending queue for a second review. Moves status from
 * `manager_approved` OR `awaiting_second_approval` -> `pending`, clearing ALL THREE
 * decision sets (manager, second approver, Accounting), the second-approver assignment,
 * and any approved-hours override, so the request is re-reviewed from scratch. Requires
 * the caller to manage the employee's department.
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
  // Recallable once the manager has approved: either already with Accounting, or
  // parked waiting on a second approver (which is the case that MUST be recoverable —
  // otherwise a request naming someone unavailable is stuck forever).
  if (row.status !== 'manager_approved' && row.status !== 'awaiting_second_approval') {
    return { error: 'Only requests forwarded to Accounting can be recalled' };
  }

  const authErr = await authorizeManagerOverAdjustment(supabase, managerLower, row.work_email);
  if (authErr.error) return authErr;

  const nowIso = new Date().toISOString();

  const { error } = await supabase
    .from(TABLE)
    .update({
      status: 'pending' as const,
      // Clear ALL THREE decision sets and the payroll override so the request restarts
      // clean. The second-approver ASSIGNMENT is cleared too: recall exists to redo the
      // review from scratch, which includes choosing who countersigns it.
      manager_decision: null,
      manager_decided_by: null,
      manager_decided_at: null,
      manager_decision_note: null,
      second_approver_email: null,
      second_approver_assigned_by: null,
      second_approver_assigned_at: null,
      second_decision: null,
      second_decided_by: null,
      second_decided_at: null,
      second_decision_note: null,
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
        prior_status: row.status,
        cleared_second_approver: row.second_approver_email ?? null,
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
 * Storage folder prefix that owns an employee's evidence objects. Keep in sync with
 * uploadTimeAdjustmentImage; used to verify submitted image_paths belong to the caller.
 */
export function adjustmentEvidencePrefix(email: string): string {
  return `${(email || 'unknown').toLowerCase().replace(/[^a-z0-9._-]/g, '_')}/`;
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

  const safeExt = (ext || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const path = `${adjustmentEvidencePrefix(email)}${requestKey}/${idx}-${Date.now()}.${safeExt}`;

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
