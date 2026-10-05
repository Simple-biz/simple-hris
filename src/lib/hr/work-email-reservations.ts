/**
 * Which @simple.biz addresses may not be minted — the pure core of
 * `loadWorkEmailReservations` (work-email-server.ts).
 *
 * Kane, 2026-10-05 (audit item 344): **an address that has ever belonged to
 * someone is never re-issued.** This replaces HR's earlier rule that an
 * off-boarded master row frees its address for recycling. Payroll keys a person
 * by work email in `employee_ids` (bank and wallet), `employee_hourly_rates`
 * (rate and paystub address) and Hubstaff, and none of those tables knows about
 * stints. Five Lead Gen hires minted a recycled address on 2026-09-26 could not
 * be promoted (`(Work Email, Department)` is unique), so they are invisible on
 * every surface, and their first pay would have gone to the previous holder's
 * Hurupay wallet.
 *
 * Two classes, because they differ in whether a missing Google account frees them:
 *
 *  - `onRecord`: the address is on a person's record in any state. That means
 *    every master row (active OR off-boarded, all three email columns),
 *    `employee_ids`, non-revoked `employee_roles`, the `offboarded_sheet` ledger
 *    (leavers whose master row was deleted) and the rates history. **Never
 *    reclaimable.** Off-boarding deletes the Google account, so "Workspace says
 *    missing" is the normal state of a leaver's address and proves nothing.
 *  - `claimed`: an in-flight hire holds it (`pending_work_email`, `ready`,
 *    `failed_to_promote`) and it is on no record yet. A failed Workspace create
 *    can leave such a claim with no account behind it. Only this class may be
 *    reclaimed when the verify webhook reports the account missing.
 *
 * `taken` = onRecord ∪ claimed, which is what the suggester avoids.
 */
export interface WorkEmailReservationSources {
  /** Every global_master_list row, regardless of off_boarded_at. */
  masterEmails: ReadonlyArray<unknown>;
  employeeIdsEmails: ReadonlyArray<unknown>;
  roleEmails: ReadonlyArray<unknown>;
  offboardedLedgerEmails: ReadonlyArray<unknown>;
  ratesEmails: ReadonlyArray<unknown>;
  inFlightPendingEmails: ReadonlyArray<unknown>;
}

export interface WorkEmailReservations {
  taken: Set<string>;
  onRecord: Set<string>;
  claimed: Set<string>;
}

/** The pending statuses whose work email is still held by that hire. */
export const IN_FLIGHT_PENDING_STATUSES = ['pending_work_email', 'ready', 'failed_to_promote'] as const;

const norm = (v: unknown): string => String(v ?? '').trim().toLowerCase();

export function buildWorkEmailReservations(src: WorkEmailReservationSources): WorkEmailReservations {
  const onRecord = new Set<string>();
  for (const list of [
    src.masterEmails,
    src.employeeIdsEmails,
    src.roleEmails,
    src.offboardedLedgerEmails,
    src.ratesEmails,
  ]) {
    for (const v of list) {
      const e = norm(v);
      if (e) onRecord.add(e);
    }
  }
  const claimed = new Set<string>();
  for (const v of src.inFlightPendingEmails) {
    const e = norm(v);
    if (e && !onRecord.has(e)) claimed.add(e);
  }
  return { taken: new Set([...onRecord, ...claimed]), onRecord, claimed };
}

/**
 * May an address the roster reports as taken be reclaimed after the verify
 * webhook says its Workspace account is `missing`? Only a pure in-flight claim.
 */
export function mayReclaimWhenWorkspaceMissing(
  email: string,
  reservations: Pick<WorkEmailReservations, 'onRecord'>,
): boolean {
  return !reservations.onRecord.has(norm(email));
}
