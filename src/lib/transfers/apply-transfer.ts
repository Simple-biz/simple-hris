import {
  applyDepartmentTransfer,
  markTransferApplied,
  type DepartmentTransferRequestRow,
} from '@/lib/supabase/department-transfer-requests';
import { updateMasterSheetDepartment } from '@/lib/google-sheets/update-master-sheet-department';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';

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
  // 1. Master list (authoritative in Supabase).
  const master = await applyDepartmentTransfer({
    personalEmail: row.employee_personal_email,
    workEmail: row.employee_work_email,
    fromDepartment: row.from_department,
    toDepartment: row.to_department,
  });
  if (master.error) {
    return { applied: false, sheetSynced: false, sheetError: null, error: master.error };
  }

  // 2. Google Sheet write-back (best-effort — the whole point of v2, but a
  //    transient API error must not strand the transfer).
  let sheetSynced = false;
  let sheetError: string | null = null;
  try {
    const sheet = await updateMasterSheetDepartment({
      personalEmail: row.employee_personal_email,
      workEmail: row.employee_work_email,
      fromDepartment: row.from_department,
      toDepartment: row.to_department,
    });
    sheetSynced = sheet.updated > 0;
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
          message: `${who} has moved from ${row.from_department} to ${row.to_department}${
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

  return { applied: true, sheetSynced, sheetError, error: null };
}
