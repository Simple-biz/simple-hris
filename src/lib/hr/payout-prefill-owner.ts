import { normEmail } from '@/lib/email/norm-email';

/**
 * What promote may do with the `employee_ids` row (bank / wallet) that already
 * sits on the hire's work email — the pure core of the payout pre-fill in
 * `promoteHrPendingEmployee` (src/lib/supabase/hr-pending-employees.ts).
 *
 * The pre-fill used to UPDATE whatever row matched the work email. Work emails
 * were recycled, so that row could be a previous holder's: on 2026-08-11 Mary
 * Rose Tronco's promote wrote her Hurupay wallet onto Mary Jean Tan's row, and
 * Tan's name and personal email then fronted every `maryt@` payout (audit
 * item 344). Payroll routes pay by work email, so writing a hire's bank details
 * onto someone else's row merges two people's payout identities.
 *
 *  - no row on the address        → insert the hire's own;
 *  - a row carrying THIS hire's personal email → update it (a rehire, or a
 *    retried promote that already inserted it);
 *  - anything else — a different personal email, or none to prove ownership →
 *    refuse. The row is left exactly as it was; Payment Dispatch's bank-owner
 *    hold (`bank-owner-hold.ts`) keeps the hire's pay off that row until a
 *    human resolves whose it is.
 */
export type PayoutPrefillDecision = 'insert' | 'update' | 'refuse';

export function decidePayoutPrefill(
  existing: { personalEmail: string | null } | null,
  hirePersonalEmail: string | null,
): PayoutPrefillDecision {
  if (!existing) return 'insert';
  const rowPersonal = normEmail(existing.personalEmail ?? '');
  const hirePersonal = normEmail(hirePersonalEmail ?? '');
  if (rowPersonal && hirePersonal && rowPersonal === hirePersonal) return 'update';
  return 'refuse';
}
