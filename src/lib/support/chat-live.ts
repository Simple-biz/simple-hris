/**
 * Employee Support LIVE CHAT — the live channel's browser-safe contract.
 *
 * `fpu-live.ts`'s twin, and deliberately so: that pattern (a server-side
 * Broadcast carrying a bare signal, every listener re-fetching through its own
 * gated route, a poll floor underneath) is the shipped answer in this codebase
 * and this feature does not get to invent a second one.
 *
 * WHY BROADCAST AND NOT `postgres_changes`
 * ---------------------------------------------------------------------------
 * The browser client is `anon`, and both chat tables have RLS on with zero
 * policies and are deliberately absent from the `supabase_realtime` publication
 * (references/sql/create/2026-09-19_employee_support_chat.sql, and the ticket
 * table's header at :26-33 which says it in capitals). A `postgres_changes`
 * subscription against them would subscribe successfully and then never fire a
 * single event — the worst failure shape there is, because it looks like it
 * works. Making it work would mean a permissive anon SELECT policy on a table
 * holding pay disputes and complaints about named managers. Never.
 *
 * THE PAYLOAD CARRIES NO CONTENT, AND THAT IS THE WHOLE POINT
 * ---------------------------------------------------------------------------
 * There is no `private: true` channel and no `realtime.setAuth` call anywhere in
 * this repo, so a Broadcast topic is readable by any holder of the public anon
 * key who subscribes to the topic string. Two shipped surfaces get this wrong
 * already — `CobrowseChatProvider.tsx:147-158` puts message TEXT on a public
 * topic and filters the recipient inside the RECEIVING browser, and
 * `GlobalPingListener.tsx` repeats it — which is why it is written out here
 * rather than left as a convention someone can reasonably not know about.
 *
 * So: no message body, no email, no name, no concern, no queue position. A
 * session id is a uuid and tells a listener nothing they can use. Everyone
 * re-fetches through a route that checks who they are.
 *
 * There is no email on the payload for a second reason: a listener narrowing on
 * `emails` (the way `FpuLivePayload` does) would be told which colleague just
 * opened a support chat, on a topic anyone can join. The cost of omitting it is
 * that every listener re-fetches on every session move; the queue is bounded by
 * what five people can hold open, so that cost is noise.
 *
 * OWN TOPIC — never reuse another feature's
 * ---------------------------------------------------------------------------
 * realtime-js keeps one channel per topic per client, so a second `.channel()`
 * on a topic the page already joined collides with the first. The employee shell
 * already joins `hris-presence` and the cobrowse topic; this one is its own.
 *
 * Plan: docs/superpowers/plans/2026-09-19-employee-support-chat.md (task 4).
 */

export const CHAT_LIVE_TOPIC = 'employee-support-chat-sync';
export const CHAT_LIVE_EVENT = 'changed';

export interface ChatLivePayload {
  /**
   * What moved.
   *
   * `session` is everybody's business: someone ahead in the line being claimed,
   * ending, or being converted changes every OTHER employee's position, so every
   * listener re-reads. `message` is narrower in principle but the payload cannot
   * say whose it is (see the header), so it also fans out — the receiving client
   * decides whether it cares based on what its own gated re-fetch returns.
   */
  kind: 'session' | 'message';
  /** Which session moved. A uuid: it identifies, it does not disclose. */
  sessionId: string;
  /**
   * Stamped by the SERVER at broadcast time and judged at RECEIVE time, so a
   * reconnect that replays an old frame can be recognised as stale rather than
   * treated as news — the rule `start-processing-broadcast.ts` established.
   */
  ts: number;
}

/**
 * The poll FLOOR, not the fallback.
 *
 * The socket is an optimisation; this is the guarantee. A lost broadcast costs
 * seconds, never correctness. Deliberately faster than the FPU surfaces' 15s:
 * someone watching their own place in a queue notices a stale number in a way
 * that someone watching an enrolment table does not.
 */
export const CHAT_LIVE_POLL_MS = 10_000;

/** Coalesce a burst — an agent claiming three sessions in a row — into one reload. */
export const CHAT_LIVE_DEBOUNCE_MS = 400;

/**
 * A broadcast payload is untrusted input like any other: it arrives over a public
 * topic that anyone holding the anon key can publish to. Parse it into the typed
 * shape, return `null` on anything malformed, and never render the raw thing.
 * (`start-processing-broadcast.ts:47-60` is the precedent.)
 */
export function parseChatLivePayload(raw: unknown): ChatLivePayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<ChatLivePayload>;
  if (p.kind !== 'session' && p.kind !== 'message') return null;
  if (typeof p.sessionId !== 'string' || p.sessionId.length === 0) return null;
  if (typeof p.ts !== 'number' || !Number.isFinite(p.ts)) return null;
  return { kind: p.kind, sessionId: p.sessionId, ts: p.ts };
}
