/**
 * Employee Support — who may do what to a ticket, and what each act does.
 *
 * Plan: docs/superpowers/plans/2026-09-21-employee-support-tickets-board.md
 * (task 5). Pure: it decides, it never writes. The routes enforce these
 * verdicts and the board disables buttons from the same ones, so a control
 * cannot be enabled for something the route will refuse — the drift that makes
 * a UI feel broken when it is actually the server being right.
 *
 * WHY THIS IS A MODULE AND NOT FOUR `if`s IN FOUR ROUTES
 * ---------------------------------------------------------------------------
 * There are five acts (claim, rank, reply, close, reopen) plus a handoff, two
 * actor kinds, and four statuses. That is a table, and a table spread across
 * route handlers is a table nobody can read. The rule most likely to rot is the
 * one about a reply to a closed ticket, and it is stated once, here.
 *
 * WHAT "TOUCHING" MEANS — KANE, 2026-09-18
 * ---------------------------------------------------------------------------
 * "Whoever touches the ticket first should automatically be assigned to that
 * ticket unless they pass it off to another person."
 *
 * A touch is the first ACTION — rank, reply, or an explicit claim. **Never a
 * read.** If opening a ticket claimed it, five people browsing the queueing
 * line would claim everything they scrolled past and the line would empty into
 * nobody's hands. That reading is assumed rather than ruled, and it is
 * reversible: {@link autoClaimsOn} is the single place it lives.
 */

import type { SupportStatus } from './types';
import type { SupportPriority } from './triage';

/** The acts a staff member can perform. `reopen` is a consequence, not a button. */
export const SUPPORT_ACTS = ['claim', 'rank', 'reply', 'close', 'reopen', 'reassign'] as const;
export type SupportAct = (typeof SUPPORT_ACTS)[number];

/**
 * The acts that AUTO-CLAIM an unheld ticket for the actor performing them.
 *
 * Reading is deliberately absent. So is `close`: closing something you never
 * held is a supervisory act, and stamping yourself as its owner on the way out
 * would misreport who actually did the work.
 */
export const AUTO_CLAIM_ACTS: readonly SupportAct[] = ['rank', 'reply', 'claim'];

export function autoClaimsOn(act: SupportAct): boolean {
  return AUTO_CLAIM_ACTS.includes(act);
}

/** Enough of a ticket to judge any act against it. */
export type LifecycleTicket = {
  status: SupportStatus;
  priority: SupportPriority;
  claimed_by: string | null;
};

/** Who is asking. `isAdmin` is the override for a ticket stuck on somebody away. */
export type Actor = {
  /** Lower-cased work email. The route resolves this from the session, never the body. */
  email: string;
  isAdmin: boolean;
};

export type Verdict =
  | { allowed: true; claims: boolean; reopens: boolean }
  | { allowed: false; reason: string };

const deny = (reason: string): Verdict => ({ allowed: false, reason });
const allow = (opts: { claims?: boolean; reopens?: boolean } = {}): Verdict => ({
  allowed: true,
  claims: opts.claims ?? false,
  reopens: opts.reopens ?? false,
});

/** Does this actor currently hold the ticket? */
export function holds(ticket: LifecycleTicket, actor: Actor): boolean {
  return ticket.claimed_by !== null && ticket.claimed_by === actor.email;
}

/**
 * Can this staff actor perform this act, and what does it do on the way?
 *
 * `claims: true` means the route must ALSO take the claim, as a compare-and-set
 * on NULL in the same request — the auto-assignment Kane asked for.
 * `reopens: true` means the act moves a closed ticket back to `open`.
 */
export function canStaffAct(
  act: SupportAct,
  ticket: LifecycleTicket,
  actor: Actor,
): Verdict {
  const held = ticket.claimed_by !== null;
  const mine = holds(ticket, actor);

  switch (act) {
    case 'claim':
      if (held) {
        return mine
          ? deny('You already hold this ticket.')
          : deny(`${ticket.claimed_by} is already handling this one.`);
      }
      if (ticket.status === 'closed') return deny('This ticket is closed. Reopen it first.');
      return allow({ claims: true });

    case 'rank':
      // Ranking is triage and triage is the whole point of the queueing line —
      // anybody on the support team may do it, including on a ticket somebody
      // else holds. Urgency is a property of the QUESTION, not of who is
      // answering it, and a line where only the holder can re-rank is a line
      // that cannot be re-prioritised when something turns out to be urgent.
      if (ticket.status === 'closed') return deny('A closed ticket is not in the line.');
      return allow({ claims: !held });

    case 'reply':
      if (ticket.status === 'closed') {
        // A STAFF reply to a closed ticket does NOT reopen it. See the employee
        // rule below for the asymmetry and why it is deliberate.
        return allow({ claims: !held });
      }
      return allow({ claims: !held });

    case 'close':
      if (ticket.status === 'closed') return deny('This ticket is already closed.');
      // The holder, or an admin. NOT any passer-by: closing is the act that
      // ends the employee's expectation of a reply, and it should belong to
      // somebody who knows the answer was given.
      if (!held) return allow();
      if (mine || actor.isAdmin) return allow();
      return deny(`${ticket.claimed_by} is handling this one. Ask them to close it, or reassign it first.`);

    case 'reopen':
      if (ticket.status !== 'closed') return deny('This ticket is not closed.');
      return allow({ reopens: true });

    case 'reassign':
      // Kane, 2026-09-18: "unless they pass it off to another person" — the
      // CURRENT holder hands it on. Plus an admin override, because a ticket
      // stuck on somebody who is away is otherwise stuck forever.
      //
      // NOTE this is the REVERSE of the dev board, where only TICKET_BOARD_OWNER
      // may reassign anything. Deliberate: these five pass work between
      // themselves and Kane is not in the loop at all.
      if (!held) return deny('Nobody holds this ticket — claim it instead.');
      if (mine || actor.isAdmin) return allow();
      return deny(`Only ${ticket.claimed_by} or an admin can pass this one on.`);

    default: {
      const never: never = act;
      return deny(`Unknown act: ${String(never)}`);
    }
  }
}

/**
 * An EMPLOYEE replying to their own ticket.
 *
 * Carla signed: *"Either side can reply again. Nothing is deleted — closed
 * questions stay readable by both."*
 *
 * THE ASYMMETRY, AND WHY IT IS NOT AN OVERSIGHT. An employee replying to a
 * closed ticket REOPENS it; a staff member replying to one does not.
 *
 * They mean different things. An employee coming back to a closed thread is
 * telling you it was not actually resolved — closing it was the company's
 * judgement and they are disagreeing with it, which is exactly the moment the
 * ticket should be alive again and back in somebody's count. A staff member
 * adding a line to a closed ticket is a postscript: "for the record, payroll
 * confirmed this on Friday." Reopening on that would put work back in the queue
 * that nobody asked for, and the person who did it would have to close it
 * again.
 *
 * Neither case ever hides anything. Closed threads stay readable by both, which
 * is the part she actually signed.
 */
export function canEmployeeReply(ticket: LifecycleTicket): Verdict {
  if (ticket.status === 'closed') return allow({ reopens: true });
  return allow();
}

/**
 * The status an act moves the ticket TO, or `null` to leave it alone.
 *
 * `first_response_at` is NOT decided here — it is stamped once, by the route,
 * and never recomputed. A ticket answered on Monday and replied to again on
 * Tuesday was still first answered on Monday, and a "time to first response"
 * that moves is not a measurement.
 */
export function nextStatus(
  act: SupportAct,
  ticket: LifecycleTicket,
  by: 'staff' | 'employee',
): SupportStatus | null {
  if (act === 'close') return 'closed';
  if (act === 'reopen') return 'open';
  if (act === 'reply') {
    if (by === 'employee') return ticket.status === 'closed' ? 'open' : null;
    // A staff reply moves an untouched ticket to 'answered'; it leaves an
    // already-answered or closed one where it is.
    return ticket.status === 'open' || ticket.status === 'claimed' ? 'answered' : null;
  }
  if (act === 'claim') return ticket.status === 'open' ? 'claimed' : null;
  return null;
}
