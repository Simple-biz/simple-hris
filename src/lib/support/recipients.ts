/**
 * Who hears about an Employee Support event.
 *
 * One pure module, mirroring src/lib/tickets/recipients.ts, so the in-app row
 * and the n8n email leg can never drift into disagreeing about who is being
 * told. Nothing here reads a database or sends anything — it answers a
 * question, and the caller acts on the answer.
 *
 * EVERY FUNCTION RETURNS null, NEVER ''.
 * ---------------------------------------------------------------------------
 * n8n's Gmail node is stop-on-error: an empty To fails the entire workflow run
 * instead of skipping that one message, which is how the orientation-email
 * Invalid-To incident happened (docs/features/tickets-board.md:109-112). Every
 * hook returns early on null rather than handing over a blank string.
 *
 * Employee-filed tickets are the likeliest source of a null: a filer whose
 * master row is missing, an alternate address, or a ticket nobody has claimed.
 */

const norm = (email: string | null | undefined): string | null => {
  const trimmed = (email ?? '').trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
};

export type SupportTicketParties = {
  /** The employee who filed it — the master work email on the row. */
  work_email: string | null;
  /** The staffer who picked it up, if anyone has. */
  claimed_by: string | null;
};

/**
 * A staff reply goes to the employee. Always, and with no exception worth
 * making: the entire point of the feature is that the person who asked finds
 * out they were answered.
 *
 * Returns null only when the row has no usable work email, which is a data
 * defect rather than a routing decision — the reply is still saved and still
 * visible in their dashboard.
 */
export function staffReplyRecipient(ticket: SupportTicketParties): string | null {
  return norm(ticket.work_email);
}

/**
 * An employee reply goes to whoever is holding the ticket.
 *
 * If nobody has claimed it, this is deliberately null rather than a broadcast to
 * all five answerers. An unclaimed ticket with a new reply is already surfaced
 * by the staff section's "needs reply" filter, which is the cheap channel; five
 * inboxes is the expensive one. This is the same asymmetry the tickets board
 * settled on — a panel row is cheap, an inbox is not — and it is not a bug to
 * be fixed by widening the email.
 */
export function employeeReplyRecipient(ticket: SupportTicketParties): string | null {
  return norm(ticket.claimed_by);
}

/**
 * A newly filed ticket goes to the configured support address, if there is one.
 *
 * There is no per-ticket owner to fall back on the way the Kanban board falls
 * back to its board owner — Carla named five people, not one, and picking one
 * of them in code would make that person the de-facto owner of everything.
 *
 * So the address is configuration: a shared support inbox that the five already
 * watch. With none configured this returns null and the hook sends nothing,
 * exactly like every other notify hook with no webhook URL — the ticket is
 * still filed and still appears on the board. Silence here is a missing setting,
 * never a lost ticket.
 */
export function ticketFiledRecipient(supportInbox: string | null | undefined): string | null {
  return norm(supportInbox);
}

/**
 * A flagged ticket does not get its own notification.
 *
 * The flag is a note to whoever opens the ticket, not an alert: routing "this
 * message contains strong language" to an inbox turns a reading aid into an
 * accusation that arrives before anyone has read the text. The staff section
 * shows flagged tickets in its own filter; that is the whole delivery mechanism.
 */
export const FLAG_HAS_NO_EMAIL_LEG = true;
