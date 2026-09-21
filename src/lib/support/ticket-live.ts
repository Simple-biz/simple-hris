/**
 * Employee Support TICKETS — the live channel's browser-safe contract.
 *
 * `chat-live.ts`'s twin, for the same reasons stated there: a server-side
 * Broadcast carrying a bare signal, every listener re-fetching through its own
 * gated route, a poll floor underneath. `employee_support_tickets` and
 * `employee_support_messages` are RLS-on with zero policies and deliberately
 * absent from `supabase_realtime` (`employee-support.md` § *It is not on the
 * dev ticket board*), so this is Broadcast-or-nothing, exactly like chat.
 *
 * This module did not exist when the employee-side routes shipped
 * (`app/api/employee/support/route.ts`, `.../[id]/messages/route.ts`) — each
 * restated the same two literals and said so in a comment, waiting for a third
 * consumer to justify the module. The staff board is that third consumer.
 *
 * NO CONTENT ON THE PAYLOAD, for the same reason as chat's: the topic is a
 * public Broadcast topic, readable by any holder of the anon key. A ticket id
 * is a uuid and discloses nothing on its own.
 */

export const TICKET_LIVE_TOPIC = 'employee-support-tickets-sync';
export const TICKET_LIVE_EVENT = 'changed';

export interface TicketLivePayload {
  /**
   * What moved. `ticket` covers a filing, a claim, a rank, a reassignment, a
   * close or a reopen — anything that changes where a ticket sits on the board
   * or in the line, which is everybody's business the way a chat session
   * moving is. `message` is a reply that did not otherwise move the ticket
   * (a second line in an already-`answered` thread); the receiving client
   * decides whether it cares once its own gated re-fetch returns.
   */
  kind: 'ticket' | 'message';
  /** Which ticket moved. A uuid: it identifies, it does not disclose. */
  ticketId: string;
  /** Stamped by the SERVER, judged at RECEIVE time — a stale reconnect frame is recognisable. */
  ts: number;
}

/** The poll floor. Same cadence as chat: someone watching a queue notices staleness fast. */
export const TICKET_LIVE_POLL_MS = 10_000;

/** Coalesce a burst — several claims in a row — into one reload. */
export const TICKET_LIVE_DEBOUNCE_MS = 400;

/**
 * A broadcast payload is untrusted input: parse it into the typed shape, never
 * render the raw thing. Same discipline as `parseChatLivePayload`.
 */
export function parseTicketLivePayload(raw: unknown): TicketLivePayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<TicketLivePayload>;
  if (p.kind !== 'ticket' && p.kind !== 'message') return null;
  if (typeof p.ticketId !== 'string' || p.ticketId.length === 0) return null;
  if (typeof p.ts !== 'number' || !Number.isFinite(p.ts)) return null;
  return { kind: p.kind, ticketId: p.ticketId, ts: p.ts };
}
