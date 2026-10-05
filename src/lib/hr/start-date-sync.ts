import { normEmail } from '@/lib/email/norm-email';

/**
 * Which master row an orientation mark may re-date — the pure core of
 * `syncStartDateToMaster` (src/lib/supabase/hr-pending-employees.ts).
 *
 * The orientation date IS the hire's Start Date, so a mark (or an edit of one)
 * pushes it to the hire's master row and Sheet row. It used to find that row by
 * (Work Email, Department). Work emails are recycled, so for a hire who is not
 * promoted yet that pair points at the PREVIOUS holder's off-boarded row: on
 * 2026-09-28 marking orientation for the five recycled-address Lead Gen hires
 * wrote 2026-09-28 onto all five previous holders' rows and three of their
 * Sheet rows (audit item 344).
 *
 * The row must be (1) the one promote linked this hire to, and (2) carry this
 * hire's Personal Email. (1) alone is not enough: before 2026-09-24 promote
 * re-stamped whatever off-boarded row held the pair, so some promoted hires are
 * still linked to someone else's row (`johnt@` #1072 → Torculas's row).
 * Missing personal email on either side cannot prove ownership — refused, the
 * same rule `decideMasterRowReuse` applies.
 */
export function decideStartDateSyncTarget(
  hire: { promotedToMasterId: string | null; personalEmail: string | null },
  master: { id: string; personalEmail: string | null } | null,
): string | null {
  const linked = hire.promotedToMasterId?.trim() ?? '';
  if (!linked || !master || master.id !== linked) return null;
  const rowPersonal = normEmail(master.personalEmail ?? '');
  const hirePersonal = normEmail(hire.personalEmail ?? '');
  if (!rowPersonal || !hirePersonal || rowPersonal !== hirePersonal) return null;
  return linked;
}
