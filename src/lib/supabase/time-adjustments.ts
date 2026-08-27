import { createSupabaseServiceRoleClient } from './server';
import { insertAuditLog } from './audit-log';
import { canActOnDisputes, resolveUserRole } from './pab-day-disputes';
import { normEmail } from '@/lib/email/norm-email';
import { overrideDeptLabel } from '@/lib/departments/dept-email-overrides';
import { listDepartmentsForManager } from './department-managers';
import { getEmployeesForAuthorizedServerRoute } from './employees';
import { departmentMatchesManagedAssignments } from '@/lib/managed-department-scope';

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

/**
 * Every request that names `approverEmail` as its second approver — the entire feed
 * behind the employee portal's Time Adjustment Approvals tab.
 *
 * This is the READ half of "the assignment IS the authorization". It is scoped by the
 * assignment and nothing else: no department filter, no role check, no status filter.
 * A person who has never been named gets an empty list, which is what keeps the tab
 * hidden for the whole company.
 *
 * Deliberately NOT filtered to undecided rows — Kane's 2026-08-27 scope is "submitted
 * time adjustments AND time adjustment history", so a row they already signed stays
 * visible to them afterwards.
 */
export async function listSecondApprovalsForApprover(approverEmail: string): Promise<{
  rows: TimeAdjustmentRow[];
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };

  const email = normEmail(approverEmail) ?? approverEmail.trim().toLowerCase();
  if (!email) return { rows: [], error: 'Not signed in' };

  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .ilike('second_approver_email', email)
    .order('created_at', { ascending: false });

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

  const empDept = await resolveAdjustmentDepartment(supabase, workEmail);
  if (!empDept || !managedDepts.includes(empDept.toLowerCase())) {
    return { error: 'Not authorized — employee is not in your managed departments' };
  }
  return { error: null };
}

/**
 * The EFFECTIVE department of the employee a request belongs to — "the respective
 * team" for both the manager's scope check and the second-approver candidate pool.
 *
 * ONE implementation on purpose: if the pool resolved the team differently from the
 * authorization check, a manager could be offered a candidate the guard then refuses
 * (or worse, the reverse). `overrideDeptLabel` applies the Sales / Sales-Assistant
 * email split, so a Sales-Assistant request offers Sales Assistants, not Sales.
 *
 * Returns null when the employee has no resolvable department — the callers treat
 * that as a REFUSAL, never as "any department will do".
 */
async function resolveAdjustmentDepartment(
  supabase: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>,
  workEmail: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('active_employees')
    .select('"Department"')
    .ilike('"Work Email"', workEmail)
    .maybeSingle();
  const dept = (
    overrideDeptLabel(
      (data as Record<string, unknown> | null)?.['Department'] as string | null,
      workEmail,
    ) ?? ''
  ).trim();
  return dept || null;
}

/**
 * The candidate pool for ONE request, with the manager's authorization checked first.
 *
 * The route layer never chooses the department — it names a request, and this resolves
 * the team from that row. That is what stops a manager from enumerating another team's
 * roster by passing a department string of their own choosing.
 *
 * Returns the resolved department alongside the emails so the picker can say WHICH team
 * it is showing (and say so honestly when the list comes back empty).
 */
export async function listSecondApproverCandidatesForRequest(
  id: string,
  managerEmail: string,
): Promise<{ emails: string[]; department: string | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { emails: [], department: null, error: 'Supabase not configured' };

  const { row, error: fetchErr } = await getTimeAdjustmentById(id);
  if (fetchErr) return { emails: [], department: null, error: fetchErr };
  if (!row) return { emails: [], department: null, error: 'Request not found' };

  const authErr = await authorizeManagerOverAdjustment(
    supabase,
    managerEmail.trim().toLowerCase(),
    row.work_email,
  );
  if (authErr.error) return { emails: [], department: null, error: authErr.error };

  const department = await resolveAdjustmentDepartment(supabase, row.work_email);
  if (!department) {
    return { emails: [], department: null, error: 'Could not resolve the department for this request' };
  }

  const { emails, error } = await listSecondApproverCandidates({
    department,
    exclude: [row.work_email, managerEmail],
  });
  return { emails, department, error };
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
  // The approver must be on the REQUEST's team. Re-resolved here rather than trusted
  // from the picker: the dropdown is a convenience, this is the guard. A cross-team
  // name — including one the client hand-crafts — is refused.
  const department = await resolveAdjustmentDepartment(supabase, row.work_email);
  if (!department) {
    return { error: "Could not resolve this employee's department — no second approver can be named" };
  }
  const eligible = await listSecondApproverCandidates({
    department,
    exclude: [row.work_email, managerLower],
  });
  if (eligible.error) return { error: `Could not verify second approver eligibility: ${eligible.error}` };
  if (!eligible.emails.includes(approver)) {
    return {
      error: `That person is not an active member of ${department} — the second approver must be on the same team as the employee`,
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
 * Everyone the manager may name as second approver on ONE request: every ACTIVE member
 * of that request's own team.
 *
 * Kane's ruling 2026-08-27 replaced the original pool (anyone, any department, who
 * already held Manager access). Two things changed and each has a reason:
 *
 * - **Team-scoped.** "The respective team" is the department of the employee who filed
 *   the request — resolved by {@link resolveAdjustmentDepartment}, the same call the
 *   manager's own authorization uses, so the pool and the guard cannot disagree. A
 *   manager of two departments gets the REQUEST's team, not the union of theirs.
 * - **No Manager access required.** Being named is now itself the authorization to
 *   countersign (and only to countersign — see `time-adjustment-requests.md`). The pool
 *   is therefore the roster, not the role table.
 *
 * The department is matched with {@link departmentMatchesManagedAssignments}, the same
 * matcher the My Team roster uses, so HSL sub-teams and "Accounting" vs "Accounting
 * Team" resolve identically here and there.
 *
 * Excluded, always: the employee whose hours are being corrected (they cannot approve
 * their own request) and the manager doing the naming (two signatures need two people).
 * Both are re-checked in {@link assignSecondApprover} — the pool is a convenience for
 * the dropdown, never the guard.
 */
export async function listSecondApproverCandidates(params: {
  /** The request's team. Callers resolve it server-side — never from client input. */
  department: string;
  /** Roster emails to leave out (the filer, the naming manager). */
  exclude?: readonly string[];
}): Promise<{
  emails: string[];
  error: string | null;
}> {
  const department = params.department.trim();
  if (!department) {
    // No resolvable team means no pool. Returning "everyone" here would silently
    // undo the team scope for exactly the rows whose department data is broken.
    return { emails: [], error: 'Could not resolve the department for this request' };
  }

  const { employees, error } = await getEmployeesForAuthorizedServerRoute();
  if (error) return { emails: [], error };

  return {
    emails: selectTeamApproverCandidates(employees, { department, exclude: params.exclude }),
    error: null,
  };
}

/**
 * The pure half of the pool: given roster rows, who is on this team and eligible?
 *
 * Split out so the team rule is testable without Supabase — the fetch above is the only
 * part that needs a database, and this is the part that decides who can sign off on a
 * change to somebody's pay.
 */
export function selectTeamApproverCandidates(
  rows: readonly {
    department: string | null;
    work_email?: string | null;
  }[],
  params: { department: string; exclude?: readonly string[] },
): string[] {
  const department = params.department.trim();
  // An empty team is not "everyone" — it is nobody. Guarded here as well as at the
  // caller so the rule holds no matter who calls it.
  if (!department) return [];

  const excluded = new Set(
    (params.exclude ?? []).map((e) => (normEmail(e) ?? e.trim().toLowerCase())).filter(Boolean),
  );

  const out = new Set<string>();
  for (const row of rows) {
    // Effective department, so a Sales-Assistant roster row does not land in the
    // Sales pool (and vice versa) just because the stored label says "Sales".
    const rowDept = overrideDeptLabel(row.department, row.work_email ?? null) ?? row.department;
    if (!departmentMatchesManagedAssignments(rowDept, [department])) continue;
    const email = normEmail(row.work_email ?? null);
    if (!email || excluded.has(email)) continue;
    out.add(email);
  }

  return [...out].sort();
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
