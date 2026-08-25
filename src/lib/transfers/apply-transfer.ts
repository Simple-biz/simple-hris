import {
  applyDepartmentTransfer,
  markTransferApplied,
  listPendingTransfers,
  cancelStaleTransfer,
  type DepartmentTransferRequestRow,
} from '@/lib/supabase/department-transfer-requests';
import { updateMasterSheetDepartment } from '@/lib/google-sheets/update-master-sheet-department';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { loadActiveDeptsByEmail, partitionStaleTransfers } from '@/lib/transfers/stale-transfers';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';

/** Today's business date (YYYY-MM-DD) in Manila — the timezone the roster runs
 *  on. Used to decide whether a released transfer's effective date is due. */
export function manilaTodayIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export type ApplyTransferResult = {
  applied: boolean;
  sheetSynced: boolean;
  sheetError: string | null;
  /**
   * True when the request was retired without a department move because the
   * employee is no longer on the active roster (off-boarded / email drift). The
   * row is flipped to `cancelled` with an explanatory note — it can never apply,
   * so this is a resolution, NOT an error.
   */
  cancelled?: boolean;
  /**
   * True when nothing needed to be written because the employee was ALREADY in
   * the target department (a prior sync / release got them there). The goal is
   * met, so the request is marked `applied` — a success, not an error.
   */
  alreadyInTarget?: boolean;
  /** Fatal error — the master-list update itself failed; nothing was applied. */
  error: string | null;
};

/** The employee's best contact address for a notification. */
function employeeRecipient(row: DepartmentTransferRequestRow): string | null {
  return (
    row.employee_work_email ||
    row.employee_personal_email ||
    row.employee_email ||
    null
  );
}

/**
 * Applies a released ("approved") transfer: writes the new department to
 * global_master_list, then writes it back to the master Google Sheet
 * (best-effort — a Sheet failure is recorded, not fatal), marks the row
 * `applied`, and notifies the receiving manager + the employee.
 *
 * Shared by the source-manager release path (when the effective date is already
 * due) and the daily apply-scheduled-transfers cron. Idempotent enough for the
 * cron: `markTransferApplied` flips the status so a row is only picked up once.
 */
export async function applyApprovedTransfer(
  row: DepartmentTransferRequestRow,
): Promise<ApplyTransferResult> {
  // 1. Master list (authoritative in Supabase). Resolves the move by TARGET dept,
  //    not by insisting on a still-in-source row (see applyDepartmentTransfer).
  const master = await applyDepartmentTransfer({
    personalEmail: row.employee_personal_email,
    workEmail: row.employee_work_email,
    fromDepartment: row.from_department,
    toDepartment: row.to_department,
  });
  if (master.error) {
    return { applied: false, sheetSynced: false, sheetError: null, error: master.error };
  }

  // 1a. Employee isn't on the active roster by any email — the transfer can never
  //     apply (off-boarded / email drift). Retire the request instead of stranding
  //     it in "approved" forever, mirroring the pending-row stale sweep.
  if (master.resolution === 'notFound') {
    const who = row.employee_name ?? row.employee_email;
    const note = `Auto-cancelled: ${who} is not on the active roster, so the move to ${formatDeptLabel(row.to_department)} can't be applied (off-boarded or email changed).`;
    await cancelStaleTransfer({ id: row.id, note, fromStatus: 'approved' });
    return { applied: false, sheetSynced: false, sheetError: null, cancelled: true, error: null };
  }

  // A fact about the MASTER LIST only: the DB row already held the target dept.
  // Drives the notification wording and the API's `already_in_target` flag. It is
  // deliberately NOT consulted for the Sheet write-back below — that conflation
  // is the bug fixed on 2026-08-25.
  const alreadyInTarget = master.resolution === 'satisfied';

  // 2. Google Sheet write-back (best-effort — the whole point of v2, but a
  //    transient API error must not strand the transfer).
  //
  //    ALWAYS attempted, including when the master-list apply resolved
  //    'satisfied'. Until 2026-08-25 that resolution short-circuited to
  //    `sheetSynced = true`: `alreadyInTarget` is a fact about the DB and was
  //    being used to assert something about the SHEET. Whenever the DB row
  //    already held the target dept for any other reason (a prior bulk relabel,
  //    an earlier transfer, any sheet-independent write) the Sheet was never
  //    touched and kept the pre-transfer department FOREVER, while the request
  //    recorded a clean `sheet_synced=true`. Measured 2026-08-25: 9 rows drifted
  //    that way, 6 of them people who then dropped out of `active_employees`
  //    entirely — the sync's (Personal Email, Department) identity key stops
  //    matching, so their `last_seen_upload_id` is never re-stamped — while
  //    still being paid off their Hubstaff hours.
  //
  //    `updated > 0` (a cell was flipped) and `alreadyTarget` (an email-matched
  //    row already reads the target) are the only two outcomes that mean the
  //    Sheet is correct. Every other zero-write outcome is real drift and is
  //    recorded as an error so the Accounting tab's "Retry" badge can surface it.
  let sheetSynced = false;
  let sheetError: string | null = null;
  try {
    const sheet = await updateMasterSheetDepartment({
      personalEmail: row.employee_personal_email,
      workEmail: row.employee_work_email,
      fromDepartment: row.from_department,
      toDepartment: row.to_department,
    });
    sheetSynced = sheet.updated > 0 || sheet.alreadyTarget === true;
    if (!sheetSynced) sheetError = sheet.reason ?? 'no matching sheet row updated';
  } catch (e) {
    sheetError = e instanceof Error ? e.message : String(e);
  }

  // 3. Record the outcome on the request.
  await markTransferApplied({ id: row.id, sheet_synced: sheetSynced, sheet_sync_error: sheetError });

  // 4. Notify the receiving manager + the employee that the move took effect.
  const supabase = createSupabaseServiceRoleClient();
  if (supabase) {
    const recipients = new Set<string>();
    const mgr = row.requested_by?.trim().toLowerCase();
    if (mgr) recipients.add(mgr);
    const emp = employeeRecipient(row)?.trim().toLowerCase();
    if (emp) recipients.add(emp);
    if (recipients.size > 0) {
      const who = row.employee_name ?? row.employee_email;
      await supabase.from('employee_notifications').insert(
        Array.from(recipients).map((to) => ({
          recipient_email: to,
          type: 'transfer.applied',
          tone: 'positive',
          title: 'Transfer Applied',
          message: alreadyInTarget
            ? `${who} is confirmed in ${formatDeptLabel(row.to_department)}.`
            : `${who} has moved from ${formatDeptLabel(row.from_department)} to ${formatDeptLabel(row.to_department)}${
                row.effective_date ? ` (effective ${row.effective_date})` : ''
              }.`,
          details: {
            request_id: row.id,
            employee_email: row.employee_email,
            from_department: row.from_department,
            to_department: row.to_department,
            effective_date: row.effective_date,
            sheet_synced: sheetSynced,
          },
        })),
      );
    }
  }

  return { applied: true, sheetSynced, sheetError, alreadyInTarget, error: null };
}

export interface StaleSweepResult {
  /** How many pending release requests were examined. */
  scanned: number;
  /** The rows actually cancelled (employee confirmed transferred out). */
  cancelled: Array<{
    id: string;
    employee_email: string;
    from_department: string;
    to_department: string;
  }>;
  error: string | null;
}

/**
 * Cancels pending release requests whose employee has already been transferred
 * OUT of the source department by some OTHER path — a co-manager releasing them,
 * the master-list Sheet sync, a direct roster edit, an off-board/re-hire. Such a
 * request can never be released meaningfully (the apply step finds no matching
 * source-department row), so it must not keep sitting in the source manager's
 * Release-requests queue — and while it lingers as `pending` it also blocks a
 * fresh transfer for the now-moved employee (see `hasPendingTransferForEmployee`).
 *
 * Cancelling writes an explanatory `approver_note` so the requester sees WHY the
 * request went away (surfaced on their "My requests"/"Done" rows). Conservative:
 * only cancels when the employee is positively located elsewhere on the active
 * roster (see {@link partitionStaleTransfers}). Best-effort per row — one failure
 * doesn't abort the sweep.
 */
export async function sweepStalePendingReleaseRequests(): Promise<StaleSweepResult> {
  const { rows: pending, error } = await listPendingTransfers();
  if (error) return { scanned: 0, cancelled: [], error };
  if (pending.length === 0) return { scanned: 0, cancelled: [], error: null };

  const { index, error: idxErr } = await loadActiveDeptsByEmail();
  if (idxErr) return { scanned: pending.length, cancelled: [], error: idxErr };

  const { stale } = partitionStaleTransfers(pending, index);
  const cancelled: StaleSweepResult['cancelled'] = [];
  for (const row of stale) {
    const who = row.employee_name ?? row.employee_email;
    const note = `Auto-cancelled: ${who} is no longer in ${formatDeptLabel(row.from_department)} (already transferred out).`;
    const { changed } = await cancelStaleTransfer({ id: row.id, note });
    if (changed) {
      cancelled.push({
        id: row.id,
        employee_email: row.employee_email,
        from_department: row.from_department,
        to_department: row.to_department,
      });
    }
  }
  return { scanned: pending.length, cancelled, error: null };
}
