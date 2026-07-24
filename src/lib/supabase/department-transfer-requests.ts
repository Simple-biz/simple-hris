import { createSupabaseServiceRoleClient } from './server';

export type TransferRequestStatus = 'pending' | 'approved' | 'applied' | 'rejected' | 'cancelled';

export type DepartmentTransferRequestRow = {
  id: string;
  employee_email: string;
  employee_name: string | null;
  employee_work_email: string | null;
  employee_personal_email: string | null;
  from_department: string;
  to_department: string;
  reason: string | null;
  status: TransferRequestStatus;
  requested_by: string;
  /** v2: source-department manager who released/declined (reuses approver_*). */
  approver_email: string | null;
  approver_note: string | null;
  decided_at: string | null;
  /** v2: receiving manager's proposed effective date (YYYY-MM-DD). */
  proposed_effective_date: string | null;
  /** v2: effective date, LOCKED when the source manager releases. */
  effective_date: string | null;
  /** v2: when the dept change was written to master + Sheet. */
  applied_at: string | null;
  /** v2: did the Google Sheet write-back succeed? Drives the "Retry" badge. */
  sheet_synced: boolean;
  sheet_sync_error: string | null;
  created_at: string;
  updated_at: string;
  /** Client-only enrichment (NOT a DB column): for a still-pending OUTGOING
   *  request, the source-department manager(s) whose Release we're awaiting.
   *  Populated by GET ?scope=outgoing so the requester sees whom to nudge — an
   *  empty array means the source department has no manager assigned. */
  pending_with?: string[];
};

/** v2 status semantics:
 *   pending   → awaiting the source manager's release decision
 *   approved  → released; effective_date locked; scheduled for that date
 *   applied   → department written to master + Sheet
 *   rejected  → source manager declined
 *   cancelled → receiving manager withdrew */

const TABLE = 'department_transfer_requests';
const MASTER_TABLE = 'global_master_list';

export async function insertTransferRequest(row: {
  employee_email: string;
  employee_name: string | null;
  employee_work_email: string | null;
  employee_personal_email: string | null;
  from_department: string;
  to_department: string;
  reason: string | null;
  requested_by: string;
  /** v2: receiving manager's proposed effective date (YYYY-MM-DD), locked on release. */
  proposed_effective_date?: string | null;
}): Promise<{ id: string | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { id: null, error: 'Supabase not configured' };

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      employee_email: row.employee_email.trim().toLowerCase(),
      employee_name: row.employee_name,
      employee_work_email: row.employee_work_email?.trim().toLowerCase() || null,
      employee_personal_email: row.employee_personal_email?.trim().toLowerCase() || null,
      from_department: row.from_department.trim(),
      to_department: row.to_department.trim(),
      reason: row.reason?.trim() || null,
      requested_by: row.requested_by.trim().toLowerCase(),
      proposed_effective_date: row.proposed_effective_date?.trim() || null,
      status: 'pending',
    })
    .select('id')
    .single();

  if (error) return { id: null, error: error.message };
  return { id: (data as { id: string } | null)?.id ?? null, error: null };
}

export async function listAllTransferRequests(limit = 300): Promise<{
  rows: DepartmentTransferRequestRow[];
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  return { rows: (data ?? []) as DepartmentTransferRequestRow[], error: error?.message ?? null };
}

/** Requests raised by one manager (their own outbox). */
export async function listTransferRequestsByRequester(
  requesterEmail: string,
  limit = 300,
): Promise<{ rows: DepartmentTransferRequestRow[]; error: string | null }> {
  const e = requesterEmail.trim().toLowerCase();
  if (!e) return { rows: [], error: null };
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .ilike('requested_by', e)
    .order('created_at', { ascending: false })
    .limit(limit);
  return { rows: (data ?? []) as DepartmentTransferRequestRow[], error: error?.message ?? null };
}

export async function getTransferRequestById(id: string): Promise<{
  row: DepartmentTransferRequestRow | null;
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };
  const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
  return { row: (data as DepartmentTransferRequestRow) ?? null, error: error?.message ?? null };
}

/** Hard-delete a transfer request row (record cleanup). Does NOT reverse an
 *  already-applied department move — it only removes the request record. */
export async function deleteTransferRequestById(id: string): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  return { error: error?.message ?? null };
}

/** True when this employee already has an in-flight transfer — either awaiting a
 *  source-manager decision (`pending`) or released and scheduled but not yet
 *  applied (`approved`). Prevents raising a second request over an open one. */
export async function hasPendingTransferForEmployee(
  employeeEmail: string,
): Promise<boolean> {
  const e = employeeEmail.trim().toLowerCase();
  if (!e) return false;
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return false;
  const { data } = await supabase
    .from(TABLE)
    .select('id')
    .in('status', ['pending', 'approved'])
    .or(`employee_email.ilike.${e},employee_work_email.ilike.${e},employee_personal_email.ilike.${e}`)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

/**
 * Pending release requests whose SOURCE department is one the given manager
 * owns — i.e. their consent queue. `departments` is the manager's active
 * department list (case-insensitive match on from_department).
 */
export async function listIncomingTransfersForDepartments(
  departments: string[],
  limit = 300,
): Promise<{ rows: DepartmentTransferRequestRow[]; error: string | null }> {
  const wanted = new Set(departments.map((d) => d.trim().toLowerCase()).filter(Boolean));
  if (wanted.size === 0) return { rows: [], error: null };
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return { rows: [], error: error.message };
  const rows = ((data ?? []) as DepartmentTransferRequestRow[]).filter((r) =>
    wanted.has(r.from_department.trim().toLowerCase()),
  );
  return { rows, error: null };
}

/**
 * Resolved release requests (anything NOT pending) whose SOURCE department is
 * one the given manager owns — their decision history for the "Done" tab.
 * Complements listIncomingTransfersForDepartments (the pending action queue):
 * once a manager releases/declines, the row leaves that queue and lands here so
 * there's still a record of what happened.
 */
export async function listResolvedTransfersForDepartments(
  departments: string[],
  limit = 300,
): Promise<{ rows: DepartmentTransferRequestRow[]; error: string | null }> {
  const wanted = new Set(departments.map((d) => d.trim().toLowerCase()).filter(Boolean));
  if (wanted.size === 0) return { rows: [], error: null };
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .neq('status', 'pending')
    // updated_at is stamped on every release/decline/cancel/apply, so it's the
    // most recent-activity ordering across all resolved statuses.
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) return { rows: [], error: error.message };
  const rows = ((data ?? []) as DepartmentTransferRequestRow[]).filter((r) =>
    wanted.has(r.from_department.trim().toLowerCase()),
  );
  return { rows, error: null };
}

/** Source manager releases a pending request: locks the effective date and moves
 *  it to `approved`. The caller applies immediately if the date is already due. */
export async function releaseTransfer(params: {
  id: string;
  source_manager_email: string;
  effective_date: string; // YYYY-MM-DD
}): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };
  const now = new Date().toISOString();
  const { error } = await supabase
    .from(TABLE)
    .update({
      status: 'approved',
      approver_email: params.source_manager_email.trim().toLowerCase(),
      effective_date: params.effective_date,
      decided_at: now,
      updated_at: now,
    })
    .eq('id', params.id)
    .eq('status', 'pending');
  return { error: error?.message ?? null };
}

/** Source manager declines a pending request. */
export async function declineTransfer(params: {
  id: string;
  source_manager_email: string;
  note: string | null;
}): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };
  const now = new Date().toISOString();
  const { error } = await supabase
    .from(TABLE)
    .update({
      status: 'rejected',
      approver_email: params.source_manager_email.trim().toLowerCase(),
      approver_note: params.note,
      decided_at: now,
      updated_at: now,
    })
    .eq('id', params.id)
    .eq('status', 'pending');
  return { error: error?.message ?? null };
}

/** Marks a released transfer as applied, recording the Sheet write-back outcome. */
export async function markTransferApplied(params: {
  id: string;
  sheet_synced: boolean;
  sheet_sync_error: string | null;
}): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };
  const now = new Date().toISOString();
  const { error } = await supabase
    .from(TABLE)
    .update({
      status: 'applied',
      applied_at: now,
      sheet_synced: params.sheet_synced,
      sheet_sync_error: params.sheet_sync_error,
      updated_at: now,
    })
    .eq('id', params.id);
  return { error: error?.message ?? null };
}

/** Updates only the Sheet write-back outcome (used by the Retry action). */
export async function setTransferSheetSync(params: {
  id: string;
  sheet_synced: boolean;
  sheet_sync_error: string | null;
}): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };
  const { error } = await supabase
    .from(TABLE)
    .update({
      sheet_synced: params.sheet_synced,
      sheet_sync_error: params.sheet_sync_error,
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.id);
  return { error: error?.message ?? null };
}

/** Released transfers whose effective date is on/before `todayIso` and not yet
 *  applied — the daily apply-scheduled-transfers cron's work list. */
export async function listScheduledDueTransfers(
  todayIso: string,
): Promise<{ rows: DepartmentTransferRequestRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('status', 'approved')
    .not('effective_date', 'is', null)
    .lte('effective_date', todayIso)
    .order('effective_date', { ascending: true });
  return { rows: (data ?? []) as DepartmentTransferRequestRow[], error: error?.message ?? null };
}

export async function updateTransferRequestStatus(params: {
  id: string;
  status: TransferRequestStatus;
  approver_email: string | null;
  approver_note: string | null;
}): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };
  const now = new Date().toISOString();
  const { error } = await supabase
    .from(TABLE)
    .update({
      status: params.status,
      approver_email: params.approver_email,
      approver_note: params.approver_note,
      decided_at: params.status === 'pending' ? null : now,
      updated_at: now,
    })
    .eq('id', params.id);
  return { error: error?.message ?? null };
}

export async function cancelTransferRequestIfOwned(params: {
  id: string;
  requested_by: string;
}): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };
  const { error } = await supabase
    .from(TABLE)
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', params.id)
    .ilike('requested_by', params.requested_by.trim().toLowerCase())
    .eq('status', 'pending');
  return { error: error?.message ?? null };
}

/**
 * Every RESOLVED release request across all departments (anything NOT pending —
 * approved / applied / rejected / cancelled), newest-activity first. Feeds the
 * admin/HR "Done" tab, which spans all teams (unlike the per-department
 * {@link listResolvedTransfersForDepartments}).
 */
export async function listAllResolvedTransfers(
  limit = 300,
): Promise<{ rows: DepartmentTransferRequestRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .neq('status', 'pending')
    .order('updated_at', { ascending: false })
    .limit(limit);
  return { rows: (data ?? []) as DepartmentTransferRequestRow[], error: error?.message ?? null };
}

/** Every still-pending release request (any source department) — the stale-sweep
 *  input for the transfer cron. */
export async function listPendingTransfers(
  limit = 500,
): Promise<{ rows: DepartmentTransferRequestRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(limit);
  return { rows: (data ?? []) as DepartmentTransferRequestRow[], error: error?.message ?? null };
}

/**
 * System cancel of a request whose employee has already been transferred OUT of
 * the source department by another path — or who's off the active roster entirely
 * (off-boarded / email drift). Unlike {@link cancelTransferRequestIfOwned} there's
 * no requester check — the trigger is the employee's state, not who raised it.
 *
 * `fromStatus` scopes which open state may be cancelled (default `pending`, the
 * stale-sweep's queue). Pass `approved` to retire a released-but-unappliable row
 * (its employee can't be found, so it can never apply). Status-guarded so
 * concurrent sweeps/applies act at most once; `changed` is true only for the
 * caller that actually flipped the row.
 */
export async function cancelStaleTransfer(params: {
  id: string;
  note: string;
  fromStatus?: 'pending' | 'approved';
}): Promise<{ changed: boolean; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { changed: false, error: 'Supabase not configured' };
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from(TABLE)
    .update({
      status: 'cancelled',
      approver_note: params.note,
      decided_at: now,
      updated_at: now,
    })
    .eq('id', params.id)
    .eq('status', params.fromStatus ?? 'pending')
    .select('id');
  if (error) return { changed: false, error: error.message };
  return { changed: (data?.length ?? 0) > 0, error: null };
}

/**
 * How an {@link applyDepartmentTransfer} resolved. The move's GOAL is
 * "employee ends up in to_department"; there's more than one way that goal is
 * (already) satisfied, and the caller needs to distinguish them:
 *   moved      — rows were written to to_department this call (the clean path).
 *   satisfied  — no write needed: the employee is ALREADY in to_department (a
 *                prior sync / co-manager release / roster edit got them there).
 *                The transfer's goal is met, so this is a SUCCESS, not an error.
 *   notFound   — the employee can't be located on the master list by any email.
 *                They've been off-boarded or their email drifted; the transfer
 *                can never apply and should be cancelled, not retried forever.
 */
export type ApplyResolution = 'moved' | 'satisfied' | 'notFound';

/**
 * A candidate master-list row for the employee being transferred. `workEmail` is
 * carried so the plan can detect a (work email, target dept) collision against the
 * partial unique index `global_master_list_work_email_dept_uniq`.
 */
export type CandidateMasterRow = { id: string | number; dept: string; workEmail?: string | null };

/**
 * The decision {@link applyDepartmentTransfer} makes before it writes anything.
 *   moveIds   — rows to re-label to the target department.
 *   deleteIds — redundant source rows to remove: moving them would collide with a
 *               row the employee ALREADY holds in the target dept (same work
 *               email), so the identity exists and the source row is a stale dupe.
 */
export type ApplyPlan =
  | { resolution: 'moved'; moveIds: Array<string | number>; deleteIds: Array<string | number> }
  | { resolution: 'satisfied'; moveIds: []; deleteIds: Array<string | number> }
  | { resolution: 'notFound'; moveIds: []; deleteIds: [] };

/**
 * PURE decision for an apply, given every master row that matched the employee's
 * email(s). Separated from the DB read/write so the branching can be unit-tested.
 * `candidates` must already be email-matched; `dept` values are compared
 * case-insensitively against from/to.
 *
 *   1. Rows still in `from_department`        → move those (clean path; preserves
 *                                                rows the person holds elsewhere).
 *      · A source row whose (work email, target) slot is ALREADY held by another
 *        active row → not moved (that would violate the unique index); instead the
 *        redundant source row is deleted, since the target identity already exists.
 *   2. Else, already in `to_department`       → nothing to move; `satisfied`.
 *   3. Else, on the roster in some other dept → reconcile: move those rows to the
 *                                                target (source label drifted).
 *   4. Else (no candidates)                   → `notFound` (off-boarded / drift).
 */
export function planDepartmentApply(
  candidates: CandidateMasterRow[],
  fromDepartment: string,
  toDepartment: string,
): ApplyPlan {
  const fromKey = fromDepartment.trim().toLowerCase();
  const toKey = toDepartment.trim().toLowerCase();
  const weKey = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();

  if (candidates.length === 0) return { resolution: 'notFound', moveIds: [], deleteIds: [] };

  // Work emails that ALREADY have an active row sitting in the target department.
  // Moving another of the employee's rows into the target with the same work email
  // would collide on global_master_list_work_email_dept_uniq.
  const targetWorkEmails = new Set(
    candidates.filter((r) => r.dept.trim().toLowerCase() === toKey && weKey(r.workEmail)).map((r) => weKey(r.workEmail)),
  );

  const sourceRows = candidates.filter((r) => r.dept.trim().toLowerCase() === fromKey);
  if (sourceRows.length > 0) {
    const moveIds: Array<string | number> = [];
    const deleteIds: Array<string | number> = [];
    for (const r of sourceRows) {
      // Collision only when the row HAS a work email and that (work email, target)
      // is already occupied. A blank-work-email row can't collide on the index.
      if (weKey(r.workEmail) && targetWorkEmails.has(weKey(r.workEmail))) deleteIds.push(r.id);
      else moveIds.push(r.id);
    }
    // If every source row was a redundant dupe (all collide), the target identity
    // already exists — the move is `satisfied`; we just prune the leftover source rows.
    if (moveIds.length === 0) return { resolution: 'satisfied', moveIds: [], deleteIds };
    return { resolution: 'moved', moveIds, deleteIds };
  }

  if (candidates.some((r) => r.dept.trim().toLowerCase() === toKey)) {
    return { resolution: 'satisfied', moveIds: [], deleteIds: [] };
  }

  return { resolution: 'moved', moveIds: candidates.map((r) => r.id), deleteIds: [] };
}

/**
 * Applies an approved transfer to the master list so the employee ends up in
 * `to_department`. Returns how many rows were written and HOW it resolved
 * (see {@link ApplyResolution}).
 *
 * The old contract required a row STILL SITTING in `from_department` and errored
 * otherwise — which stranded every overdue transfer whose employee had already
 * been moved out of the source team by another path (a Sheet sync, a co-manager
 * release, a direct roster edit). The goal is the TARGET dept, so matching is now
 * by email first, source dept second (see {@link planDepartmentApply}).
 */
export async function applyDepartmentTransfer(params: {
  personalEmail: string | null;
  workEmail: string | null;
  fromDepartment: string;
  toDepartment: string;
}): Promise<{ updated: number; resolution: ApplyResolution; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { updated: 0, resolution: 'notFound', error: 'Supabase not configured' };

  const to = params.toDepartment.trim();
  if (!to) return { updated: 0, resolution: 'notFound', error: 'Target department is required' };

  const pe = params.personalEmail?.trim().toLowerCase() || null;
  const we = params.workEmail?.trim().toLowerCase() || null;
  if (!pe && !we)
    return { updated: 0, resolution: 'notFound', error: 'Employee has no email on file to match' };

  // Pull this employee's rows across ALL departments — filtered SERVER-SIDE by
  // email so we never hit the 1000-row default cap on an unfiltered select (the
  // roster is >1000 rows; a full scan silently truncates and would drop the very
  // person we're looking for — making a valid transfer look un-appliable). One
  // .ilike query per email (case-insensitive) avoids .or()-string quoting on the
  // space-containing "Work Email"/"Personal Email" column names.
  const byId = new Map<string | number, CandidateMasterRow>();
  for (const [email, col] of [
    [we, 'Work Email'],
    [pe, 'Personal Email'],
  ] as const) {
    if (!email) continue;
    const { data, error } = await supabase
      .from(MASTER_TABLE)
      .select('id, "Personal Email", "Work Email", "Department"')
      .ilike(`"${col}"`, email);
    if (error) return { updated: 0, resolution: 'notFound', error: error.message };
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      // Re-check with trim to match the app's exact normalization (ilike ignores
      // case but not surrounding whitespace).
      const rPe = String(row['Personal Email'] ?? '').trim().toLowerCase();
      const rWe = String(row['Work Email'] ?? '').trim().toLowerCase();
      if ((pe && rPe === pe) || (we && rWe === we)) {
        const id = row.id as string | number;
        if (!byId.has(id)) {
          byId.set(id, { id, dept: String(row['Department'] ?? ''), workEmail: rWe });
        }
      }
    }
  }
  const candidates: CandidateMasterRow[] = [...byId.values()];

  const plan = planDepartmentApply(candidates, params.fromDepartment, params.toDepartment);

  // `notFound` is an EXPECTED resolution, not a failure: the employee isn't on the
  // active roster so the transfer can never apply. `error` stays null so the caller
  // routes it to the graceful auto-cancel path (a non-null error would short-circuit
  // there as a fault and strand the request). Real faults below still set `error`.
  if (plan.resolution === 'notFound') {
    return { updated: 0, resolution: 'notFound', error: null };
  }

  // Prune redundant source rows first: they duplicate an identity that already
  // lives in the target dept, so moving them would violate the (work email, dept)
  // unique index. Deleting clears the stale source-dept row so the person no longer
  // appears on the old team. Do this before the UPDATE so the target slot is free.
  if (plan.deleteIds.length > 0) {
    const { error: delErr } = await supabase.from(MASTER_TABLE).delete().in('id', plan.deleteIds);
    if (delErr) return { updated: 0, resolution: plan.resolution, error: delErr.message };
  }

  if (plan.resolution === 'satisfied') {
    return { updated: 0, resolution: 'satisfied', error: null };
  }

  const { error: updErr } = await supabase.from(MASTER_TABLE).update({ Department: to }).in('id', plan.moveIds);
  if (updErr) return { updated: 0, resolution: 'moved', error: updErr.message };
  return { updated: plan.moveIds.length, resolution: 'moved', error: null };
}
