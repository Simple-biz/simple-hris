/**
 * WHO gets told about a ticket update. One pure module, because the two legs of
 * every notification — the in-app row and the n8n email — must agree, and the
 * only way to guarantee that is for both to call the same function.
 *
 * Kane's rules, 2026-08-21:
 *
 *  - **A comment goes to the counterparty.** The ticket's creator hears about
 *    every reply on their request; when the creator is the one who typed it,
 *    the assigned developer hears instead. Nobody is ever told about their own
 *    comment, and a third party commenting does not silence the creator.
 *  - **A move goes to the creator, and only the creator.** The developer is
 *    usually the one dragging the card, so mailing them their own move is pure
 *    noise. If the creator moved it themselves, nobody is mailed.
 *
 * Everything here is lower-cased and trimmed before comparison: `created_by`,
 * `assigned_to` and the session email all reach this code from different
 * places (master list, picker, NextAuth) and casing has already caused one
 * cross-wire in this codebase — see the shared-personal-email KPI incident.
 */

/** The minimum of a ticket needed to decide who hears about a change. */
export type TicketParties = {
  created_by: string;
  assigned_to: string | null;
};

function norm(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase();
}

/**
 * The single person to email/notify about a new comment: the creator, or the
 * assigned developer when the creator is the one who wrote it. `null` when
 * there is nobody left to tell — a creator commenting on their own unassigned
 * ticket, or a ticket whose only party is the actor.
 *
 * NOTE this returns ONE recipient by design. The in-app `ticket.replied` leg in
 * POST /api/tickets/[id]/comments notifies creator AND assignee (both, minus
 * the actor) and predates this rule; it keeps that behaviour, because an in-app
 * row is cheap and an inbox is not. The email is the narrower of the two on
 * purpose — see docs/features/tickets-board.md.
 */
export function commentEmailRecipient(
  ticket: TicketParties,
  actorEmail: string,
): string | null {
  const actor = norm(actorEmail);
  const creator = norm(ticket.created_by);
  const assignee = norm(ticket.assigned_to);

  if (creator && creator !== actor) return creator;
  // The creator is the one talking — the dev working it needs to hear the reply.
  if (assignee && assignee !== actor) return assignee;
  return null;
}

/**
 * The single person to email/notify about a status move: the ticket's creator,
 * unless they are the one who moved it. `null` otherwise — never the developer.
 */
export function moveEmailRecipient(
  ticket: TicketParties,
  actorEmail: string,
): string | null {
  const creator = norm(ticket.created_by);
  return creator && creator !== norm(actorEmail) ? creator : null;
}
