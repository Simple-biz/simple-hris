/**
 * Which roster row a typed address belongs to, and which inbox the code goes to.
 *
 * Pure so it can be tested; `otp.ts` fetches the candidate rows and calls this.
 *
 * THE PERSON IS ALWAYS THE PRIMARY WORK EMAIL. Whatever column matched, the
 * returned `workEmail` is the row's `"Work Email"` — the OTP row, the session and
 * every saved submission are keyed to it, so an alternate never becomes a second
 * identity for the same human.
 *
 * THE CODE GOES TO THE INBOX THE PERSON TYPED — when that inbox is a company one.
 * Kane, 2026-09-23: *"redirect Alternate Emails and connect it with their actual
 * emails so we can give them the code"*. travis@ is Arcy Bucu's Alternate Work
 * Email; codes mailed to the primary (arcyb@) were sent and never read. So a
 * matched alternate on the company domain receives the code itself. Anything else
 * — a personal address, or an alternate cell holding a non-company address —
 * still delivers to the primary, so the flow stays gated on a simple.biz inbox.
 *
 * Precedence, and why:
 *  1. `"Work Email"` — a person's own primary always beats being someone else's
 *     alternate (4 live alternates ARE another active row's Work Email).
 *  2. `"Alternate Work Email"` / `"Alternate Work Email 2"` — must resolve to ONE
 *     person. Two different people claiming the same alternate is refused, not
 *     guessed: a guess mails a colleague's gift code to the wrong human.
 *  3. `"Personal Email"` — unchanged behaviour (first match, delivered to the
 *     primary).
 */
import { normEmail } from '@/lib/email/norm-email';
import { WORK_EMAIL_DOMAIN } from '@/lib/hr/work-email';

export interface RosterEmailRow {
  name: string | null;
  workEmail: string | null;
  personalEmail: string | null;
  alternateWorkEmail: string | null;
  alternateWorkEmail2: string | null;
  startDate: string | null;
}

export type MatchedOn = 'work_email' | 'alternate_work_email' | 'personal_email';

export interface TypedEmailMatch {
  row: RosterEmailRow;
  /** The canonical company address. Every later step is keyed to this. */
  workEmail: string;
  /** Where the code is mailed. Equals `workEmail` unless a company alternate matched. */
  deliverTo: string;
  matchedOn: MatchedOn;
}

export function isCompanyInbox(email: string): boolean {
  return email.endsWith(`@${WORK_EMAIL_DOMAIN}`);
}

export function resolveTypedEmail(
  typed: string,
  rows: readonly RosterEmailRow[],
): TypedEmailMatch | null {
  const target = normEmail(typed);
  if (!target) return null;

  // No company inbox means no way to deliver a code; such a row can never match.
  const usable = rows.flatMap((row) => {
    const workEmail = normEmail(row.workEmail);
    return workEmail ? [{ row, workEmail }] : [];
  });

  const byWork = usable.find((u) => u.workEmail === target);
  if (byWork) {
    return { row: byWork.row, workEmail: byWork.workEmail, deliverTo: byWork.workEmail, matchedOn: 'work_email' };
  }

  const byAlt = usable.filter(
    (u) =>
      normEmail(u.row.alternateWorkEmail) === target ||
      normEmail(u.row.alternateWorkEmail2) === target,
  );
  if (byAlt.length > 0) {
    // Several rows for ONE person (same primary) is one human; several primaries is not.
    const people = new Set(byAlt.map((u) => u.workEmail));
    if (people.size !== 1) return null;
    const hit = byAlt[0];
    return {
      row: hit.row,
      workEmail: hit.workEmail,
      deliverTo: isCompanyInbox(target) ? target : hit.workEmail,
      matchedOn: 'alternate_work_email',
    };
  }

  const byPersonal = usable.find((u) => normEmail(u.row.personalEmail) === target);
  if (byPersonal) {
    return {
      row: byPersonal.row,
      workEmail: byPersonal.workEmail,
      deliverTo: byPersonal.workEmail,
      matchedOn: 'personal_email',
    };
  }

  return null;
}
