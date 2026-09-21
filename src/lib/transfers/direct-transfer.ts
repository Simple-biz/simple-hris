// A department move made DIRECTLY by an accountant from Payment Catalog →
// Departments → Edit (master-list card, People step). Kane, 2026-09-21.
//
// Unlike the manager flow this has no request/release round-trip — an
// accountant editing the department IS the decision — but it deliberately still
// writes a `department_transfer_requests` row and marks it `applied`:
//
//   - [[hris-is-dept-source-of-truth]] (Kane, 2026-08-21): when the DB and the
//     Sheet disagree, the DB wins, and "the strongest evidence of the DB's value
//     being deliberate is an `applied` row in `department_transfer_requests`".
//     A move that skipped the row would be indistinguishable from drift the next
//     time somebody reconciles.
//   - The Sheet write-back outcome has nowhere else to live. `sheet_synced` /
//     `sheet_sync_error` are what drive Accounting's "Retry" badge, so a silent
//     Sheet failure here would strand the person in the old department on the
//     Sheet and the next master sync would snap them back
//     ([[transfer-sheet-sync-false-success]], [[sheet-readd-dept-clobber]]).
//   - The paystub's mid-week transfer disclosure and the HSL weekend-premium
//     effective map are both built from this table.
//
// WEEKEND PREMIUM: `buildHslTransferEffectiveMap` skips any row whose
// `from_department` is already HSL-family, so an HSL sub-team reshuffle written
// here does NOT reset a long-tenured person's +₱15/h day-scoping. A move INTO
// HSL from outside correctly does set it. Nothing here needs to special-case
// that — but changing the from/to labels written below would break it.

import {
  applyDepartmentTransfer,
  insertTransferRequest,
  markTransferApplied,
  updateTransferRequestFields,
} from '@/lib/supabase/department-transfer-requests';
import { updateMasterSheetDepartment } from '@/lib/google-sheets/update-master-sheet-department';
import { manilaTodayIso } from '@/lib/transfers/apply-transfer';

export interface DirectMoveInput {
  name: string | null;
  workEmail: string;
  personalEmail: string | null;
  fromDepartment: string;
  toDepartment: string;
  /** Accountant making the change; recorded as `requested_by`. */
  actor: string;
  reason: string | null;
}

export interface DirectMoveResult {
  workEmail: string;
  /** The master-list write landed (or was already satisfied). */
  moved: boolean;
  /** `notFound` — the person is not on the active roster, so nothing moved. */
  notOnRoster: boolean;
  /** The master Google Sheet now agrees. */
  sheetSynced: boolean;
  sheetError: string | null;
  /** The transfer row, when one was written. */
  requestId: string | null;
  /** Fatal: the master-list write itself failed. */
  error: string | null;
}

/**
 * Move ONE person's department: master list first, Sheet second, both recorded
 * on an `applied` transfer row.
 *
 * Order matters. The master list is authoritative, so it is written first and a
 * failure there is fatal and returns before anything else is touched. The Sheet
 * is best-effort — a Sheets outage must not strand the move — but a zero-write
 * outcome is reported as an error rather than swallowed, because the only two
 * outcomes that mean the Sheet is CORRECT are "a cell was flipped" and "an
 * email-matched row already reads the target". That conflation was a real bug
 * (fixed 2026-08-25); do not reintroduce it by treating `satisfied` as synced.
 */
export async function applyDirectDepartmentMove(input: DirectMoveInput): Promise<DirectMoveResult> {
  const workEmail = input.workEmail.trim().toLowerCase();
  const personalEmail = input.personalEmail?.trim().toLowerCase() || null;
  const from = input.fromDepartment.trim();
  const to = input.toDepartment.trim();

  const base: DirectMoveResult = {
    workEmail,
    moved: false,
    notOnRoster: false,
    sheetSynced: false,
    sheetError: null,
    requestId: null,
    error: null,
  };

  // 1. Master list (authoritative). Resolves by TARGET, not by insisting on a
  //    still-in-source row — see planDepartmentApply.
  const master = await applyDepartmentTransfer({
    personalEmail,
    workEmail,
    fromDepartment: from,
    toDepartment: to,
  });
  if (master.error) return { ...base, error: master.error };

  // Not on the active roster by any email: the move can never apply. Report it
  // rather than writing a transfer row that could never be true.
  if (master.resolution === 'notFound') {
    return { ...base, notOnRoster: true };
  }

  // 2. The record of the decision.
  const today = manilaTodayIso();
  const { id: requestId, error: insertErr } = await insertTransferRequest({
    employee_email: workEmail,
    employee_name: input.name?.trim() || null,
    employee_work_email: workEmail,
    employee_personal_email: personalEmail,
    from_department: from,
    to_department: to,
    reason: input.reason,
    requested_by: input.actor,
    proposed_effective_date: today,
  });
  if (requestId) {
    await updateTransferRequestFields({
      id: requestId,
      effective_date: today,
      reason: input.reason,
      approver_note: 'Applied directly from Payment Catalog → Departments → Edit.',
    });
  }

  // 3. Google Sheet write-back (best-effort, never fatal, never assumed).
  let sheetSynced = false;
  let sheetError: string | null = null;
  try {
    const sheet = await updateMasterSheetDepartment({
      personalEmail,
      workEmail,
      fromDepartment: from,
      toDepartment: to,
    });
    sheetSynced = sheet.updated > 0 || sheet.alreadyTarget === true;
    if (!sheetSynced) sheetError = sheet.reason ?? 'no matching sheet row updated';
  } catch (e) {
    sheetError = e instanceof Error ? e.message : String(e);
  }

  if (requestId) {
    await markTransferApplied({ id: requestId, sheet_synced: sheetSynced, sheet_sync_error: sheetError });
  }

  return {
    ...base,
    moved: true,
    sheetSynced,
    sheetError: sheetError ?? (insertErr ? `transfer row not recorded: ${insertErr}` : null),
    requestId,
  };
}
