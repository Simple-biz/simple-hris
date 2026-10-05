// When a MESA request may leave Accounting -> MESA -> Requests for the Archived view.
//
// Accounting asked (tickets board, 2026-10-05) for an Archive button on
// "Completed" requests, hidden from the main view but still viewable. There is
// no Completed status — `mesa_requests.status` is pending / approved / denied —
// so "completed" is defined HERE, once, as "nothing is left to happen to it":
//
//   denied                         -> complete. Nothing was released.
//   approved opt_out               -> complete. Membership was ended at approval;
//                                     the balance it releases is its own
//                                     `mesa_payroll_obligations` row, which
//                                     archiving the request does not touch.
//   approved disbursement, PAID    -> complete. `dispatched_at` is set.
//   approved disbursement, unpaid  -> NOT complete. Money is still owed, and a
//                                     hidden approved draw is how a payout gets
//                                     forgotten (docs/features/mesa.md:65).
//   approved return                -> NOT complete. Nothing takes a return out of
//                                     a paycheck yet (Open items 349), so an
//                                     approved return is still outstanding.
//   pending                        -> NOT complete. Awaiting a decision.
//
// Browser-safe: the Requests tab decides which rows get the button and the
// PATCH route refuses everything else with the SAME function, so the two cannot
// disagree about what may be hidden.

export interface ArchivableMesaRequest {
  request_type: string | null;
  status: string | null;
  dispatched_at?: string | null;
  /** Absent before the 2026-10-05 archive migration runs — read as not archived. */
  archived_at?: string | null;
}

export type MesaRequestCompletion =
  | { complete: true }
  | { complete: false; reason: string };

export function mesaRequestCompletion(r: ArchivableMesaRequest): MesaRequestCompletion {
  const status = (r.status ?? '').toLowerCase();
  if (status === 'denied') return { complete: true };
  if (status !== 'approved') {
    return { complete: false, reason: 'Still pending a decision.' };
  }
  switch (r.request_type) {
    case 'opt_out':
    case 'opt_in':
      return { complete: true };
    case 'disbursement':
      return r.dispatched_at
        ? { complete: true }
        : { complete: false, reason: 'Approved but not paid out yet.' };
    case 'return':
      return {
        complete: false,
        reason: 'Approved, but nothing has taken the return from a paycheck yet.',
      };
    default:
      return { complete: false, reason: 'Unknown request type.' };
  }
}

export function isMesaRequestArchived(r: ArchivableMesaRequest): boolean {
  return typeof r.archived_at === 'string' && r.archived_at !== '';
}

/**
 * Why archiving (archive = true) or unarchiving (archive = false) this row is
 * refused, or null when allowed. Repeating the row's current state (archiving an
 * archived row) is allowed, so a double-click is a no-op, not an error.
 */
export function mesaArchiveRefusal(r: ArchivableMesaRequest, archive: boolean): string | null {
  if (!archive) return null;
  if (isMesaRequestArchived(r)) return null;
  const c = mesaRequestCompletion(r);
  return c.complete ? null : `Only a completed request can be archived. ${c.reason}`;
}
