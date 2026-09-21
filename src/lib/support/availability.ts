/**
 * Employee Support LIVE CHAT — who is actually at the desk.
 *
 * Q4: **an explicit "I'm on the queue" toggle, never presence.** This module is
 * the arithmetic behind it — hand it the `employee_support_chat_agents` rows and
 * an instant, get back one of four honest answers. Pure: no clock of its own, no
 * network, no Supabase.
 *
 * THIS IS NOT THE SAME QUESTION AS `hours.ts`
 * ---------------------------------------------------------------------------
 * `hours.ts` answers *is the desk open* (Mon–Fri 9–5 Eastern, Carla's
 * Decision 3). This answers *is anybody sitting at it*. They disagree routinely
 * and both answers are true: open with nobody on the queue at 12:30, and
 * somebody on the queue at 6 PM because they chose to be. A surface that shows
 * one and calls it the other will tell an employee to wait for a person who is
 * not there. Nothing here reads a timezone, a weekday or a wall clock, and
 * nothing here should start to.
 *
 * `agentsOnQueue` IS DERIVED FROM STAMPS, NEVER FROM PRESENCE
 * ---------------------------------------------------------------------------
 * `user_presence` cannot gate this, for two independent reasons and either one
 * would be enough:
 *
 * 1. **It is forgeable.** `POST /api/presence/heartbeat` takes the email from
 *    the REQUEST BODY when there is no NextAuth session
 *    (`app/api/presence/heartbeat/route.ts:15-30`, SECURITY_AUDIT.md:245 row
 *    #50: *"POST {\"email\":\"ceo@simple.biz\"} marks CEO as online without
 *    credentials"*). Anyone could put Carla on the support queue.
 * 2. **It answers a different question.** Presence means *a tab is open*.
 *    On-queue means *I am taking chats right now*. An agent doing payroll with
 *    the HRIS open all day is present and is not available, and conflating the
 *    two would route an employee's question to somebody who never agreed to
 *    take it.
 *
 * So the only input here is `employee_support_chat_agents`, and the exported
 * signatures deliberately accept nothing that a presence row would satisfy.
 *
 * WHY THE TOGGLE AND THE HEARTBEAT ARE TWO FACTS AND NOT ONE
 * ---------------------------------------------------------------------------
 * `on_queue` is a DECLARATION; `last_heartbeat_at` is EVIDENCE (SQL `:301-307`).
 * Available means **both**: they said yes, and their browser is still saying so.
 * Either alone is a lie in a different direction — a declaration alone keeps a
 * closed laptop on the queue all night, and evidence alone is presence again.
 *
 * EXPIRY IS LAZY, COMPARED ON READ. THERE IS NO SWEEP AND NO CRON.
 * ---------------------------------------------------------------------------
 * `docs/features/INDEX.md:42` — *"Never add a cron"*: every `/api/cron/*` 401s
 * on the fail-closed `CRON_SECRET` gate and the two declared crons have never
 * once run, 0 audit rows, ever. A sweep that never runs is worse than no sweep,
 * because the stale row then *looks* maintained. So nothing in this file
 * mutates anything: staleness is a comparison performed at the moment somebody
 * asks, exactly as `app/api/presence/active/route.ts:30-42` and
 * `src/lib/bank-update/otp.ts:181` do it.
 *
 * Plan: docs/superpowers/plans/2026-09-19-employee-support-chat.md (task 6).
 */

import { normEmail } from '@/lib/email/norm-email';

/**
 * How often an agent's browser stamps `last_heartbeat_at` while their toggle is
 * on. Twice the rate of the shipped presence beat
 * (`PresenceProvider.tsx:128` — 60s), because this stamp is load-bearing in a
 * way that "last seen 5m ago" is not: an employee decides whether to wait on it.
 */
export const AGENT_HEARTBEAT_MS = 30_000;

/**
 * How long a heartbeat stays believable. Past this, a declared-on agent reads
 * as gone — no row is touched, the comparison simply stops passing.
 *
 * WHY 90s AND NOT THE PRESENCE PAIR'S 120s
 * ---------------------------------------------------------------------------
 * The shipped precedent is a 60s beat inside a 120s window
 * (`PresenceProvider.tsx:128`, `app/api/presence/active/route.ts:9`) — a ratio
 * of **2**, which tolerates exactly one dropped beat and not a moment more.
 * Copying the pair outright would be wrong in both halves here:
 *
 * * The WINDOW has to be **shorter** than presence's. Presence is answering
 *   "when were they last around", where being 90 seconds out of date is
 *   cosmetic. This answers "is somebody about to pick me up", where two
 *   stale minutes is an employee sitting in a line watching a promise that
 *   nobody is behind. It must go quiet quickly.
 * * The RATIO has to be **larger** than presence's. A single dropped request on
 *   a flaky network — which is the failure `presence/active`'s own header says
 *   it exists to survive — would otherwise flip "Carla is here" to "nobody is
 *   on" while Carla is looking straight at the screen, and the employee would
 *   give up on a queue that was working.
 *
 * 30s/90s is a ratio of **3**: an agent must miss two beats outright and then
 * be late for the third before we call them gone, and the worst-case lie is
 * 90 seconds long instead of 120. Both numbers moved in the direction the
 * queue needs, which is why this is a decision and not a copy.
 *
 * NOT the employee's own `last_seen_at` window. That one belongs to plan task
 * 14's abandonment sweep and must be derived from the EMPLOYEE's cadence — the
 * dialog polls every 10s open and every 45s shut (`EmployeeSupportChat.tsx:167-168`),
 * and "closing the modal does not leave the queue" (plan `:89-90`) means the
 * slow one is the one that has to fit. These constants are the AGENT's; do not
 * borrow them for that.
 */
export const AGENT_STALE_AFTER_MS = 90_000;

/**
 * One `employee_support_chat_agents` row, as much of it as this module reads.
 *
 * `on_queue` is required and is not optional-with-a-default on purpose: a
 * presence row has no such field, so a caller cannot reach these functions with
 * one by accident. The SQL's both-or-neither CHECKs (`:328-331`) guarantee the
 * stamps line up with the boolean, and {@link isAgentOnQueue} still checks —
 * see the fail-closed note there.
 */
export type ChatAgentRow = {
  agent_email: string;
  agent_name?: string | null;
  /** The DECLARATION. */
  on_queue: boolean;
  /** The EVIDENCE, ISO-8601. `null` whenever `on_queue` is false. */
  last_heartbeat_at: string | null;
  /** When they declared it — "on the queue since 9:04". Survives every beat. */
  on_queue_since?: string | null;
};

/**
 * The four honest answers. **Four, not two** — `nobody_on` and `unknown` are
 * different states and no surface may render them alike, for the same reason a
 * queue position of `0` and an unread one are different (plan `:91-92`).
 */
export type ChatAvailabilityState =
  /** At least one agent is on the queue and free to take the next waiter. */
  | 'agents_free'
  /** Agents are on the queue, and every one of them is already in a chat. */
  | 'agents_busy'
  /** We read the table and nobody is on. A fact, and a disappointing one. */
  | 'nobody_on'
  /** We could not tell. Show a skeleton; never borrow one of the other three. */
  | 'unknown';

export type ChatAvailability = {
  state: ChatAvailabilityState;
  /**
   * Agents declared on-queue whose heartbeat is inside the window. **`null`
   * means UNKNOWN, not zero** — the same distinction `cycle-performance.ts:113-121`
   * makes about a cycle with no dispatch rows, and for the same reason: `0`
   * here reads as "nobody is on", which is a claim we have not earned.
   */
  onQueue: number | null;
  /**
   * Of those, how many are not already holding a conversation. `null` when we
   * could not tell — which can happen even while `onQueue` is a number, because
   * the two come from different reads.
   */
  free: number | null;
};

/**
 * There is deliberately no `isAnyoneAvailable(): boolean` export.
 *
 * A boolean has two states and this has four, so every caller of such a helper
 * would have to pick which two of ours to throw away — and the pair that gets
 * collapsed is always `nobody_on` with `unknown`, which is the one collapse
 * this feature is not allowed to make.
 */

/** What the EMPLOYEE reads. Their language, not the schema's. */
export const CHAT_AVAILABILITY_LABELS: Record<ChatAvailabilityState, string> = {
  agents_free: 'Someone is on the queue now',
  agents_busy: 'Everyone on the queue is in a chat',
  nobody_on: 'Nobody is on the queue right now',
  unknown: 'Checking who is on the queue…',
};

/** What the AGENT reads. The same row, the other side of the desk. */
export const CHAT_AVAILABILITY_LABELS_AGENT: Record<ChatAvailabilityState, string> = {
  agents_free: 'On the queue, free',
  agents_busy: 'On the queue, all in chats',
  nobody_on: 'Nobody on the queue',
  unknown: 'Availability unknown',
};

/**
 * Tone and label as two parallel Records, matching `chat-types.ts:78-96` and
 * `types.ts:58-72`.
 *
 * `unknown` gets its OWN tone rather than sharing `neutral` with `nobody_on`.
 * The two must never render the same, and leaving them the same colour is
 * exactly how they eventually do — a `'unknown'` tone means a component has to
 * write the skeleton branch to satisfy the Record, rather than discovering that
 * grey happened to be handy.
 */
export const CHAT_AVAILABILITY_TONE: Record<
  ChatAvailabilityState,
  'good' | 'waiting' | 'neutral' | 'unknown'
> = {
  agents_free: 'good',
  agents_busy: 'waiting',
  nobody_on: 'neutral',
  unknown: 'unknown',
};

/**
 * How old the heartbeat is, in ms. `null` when there is no stamp — which is
 * "we have no evidence", not "infinitely old", and the caller must not turn it
 * into a number by coalescing.
 *
 * A NEGATIVE age (a stamp in the future, from clock skew between the DB and
 * this process) is returned as-is rather than clamped: it is still inside the
 * window, so it still reads as fresh, and hiding the sign would hide the skew
 * from anybody debugging it.
 */
export function agentHeartbeatAgeMs(agent: ChatAgentRow, now: Date): number | null {
  if (!agent.last_heartbeat_at) return null;
  const beat = Date.parse(agent.last_heartbeat_at);
  if (!Number.isFinite(beat)) return null;
  return now.getTime() - beat;
}

/**
 * Is this agent taking chats right now? Declaration AND evidence, both.
 *
 * FAILS CLOSED on a row that should not exist. The SQL CHECK
 * `employee_support_chat_agents_beat_matches_toggle` (`:330-331`) makes
 * `on_queue` with a NULL heartbeat illegal, so this branch is unreachable from
 * the database — but this function is also handed parsed JSON, and the right
 * answer to a row we do not understand is "not available", never "available".
 *
 * The window is EXCLUSIVE at the top: an age of exactly
 * {@link AGENT_STALE_AFTER_MS} is stale. One definition, one boundary, so the
 * agent's own toggle and the employee's copy cannot land on different sides.
 */
export function isAgentOnQueue(agent: ChatAgentRow, now: Date): boolean {
  if (!agent.on_queue) return false;
  const age = agentHeartbeatAgeMs(agent, now);
  if (age === null) return false;
  return age < AGENT_STALE_AFTER_MS;
}

/**
 * The agents actually on the queue at this instant, in no promised order.
 * `null` in, `null` out — an unread table is not an empty one.
 */
export function agentsOnQueue(
  agents: readonly ChatAgentRow[] | null,
  now: Date,
): ChatAgentRow[] | null {
  if (!agents) return null;
  return agents.filter((a) => isAgentOnQueue(a, now));
}

/**
 * The one summary every surface reads.
 *
 * @param agents every `employee_support_chat_agents` row, or `null` when the
 *   read failed. Five rows at most — this table has one row per named agent and
 *   Kane granted five — so it does not page. That is a fact about THIS table and
 *   not a licence: the waiting set next door is unbounded and must use
 *   `selectAllPaged` (`queue.ts` header).
 * @param engaged the `claimed_by` of every session currently `claimed` or
 *   `live`, or `null` when THAT read failed. Nullable and required rather than
 *   optional, so a caller has to state which it means: passing `[]` claims
 *   nobody is in a chat, and that claim should be made on purpose.
 * @param now the instant to judge staleness against. Passed in, never read from
 *   the module, so the tests can stand still.
 */
export function summarizeChatAvailability(input: {
  agents: readonly ChatAgentRow[] | null;
  engaged: readonly (string | null | undefined)[] | null;
  now: Date;
}): ChatAvailability {
  const on = agentsOnQueue(input.agents, input.now);
  if (!on) return { state: 'unknown', onQueue: null, free: null };

  // Counted, so it is a fact. `0` here means we looked and nobody was on — the
  // only path in this module that is allowed to say that.
  if (on.length === 0) return { state: 'nobody_on', onQueue: 0, free: 0 };

  if (!input.engaged) {
    // We know how many are on and NOT whether any of them is free. Reporting
    // `agents_free` would be a guess in the employee's favour and
    // `agents_busy` a guess against them; the count is still worth handing
    // back, so it goes back with the state that admits what is missing.
    return { state: 'unknown', onQueue: on.length, free: null };
  }

  // Both sides are lowercased by trigger (SQL `:373`, `:412`), so this is a
  // second belt: the module is also handed JSON, and an address that differs
  // only in case would quietly count a busy agent as free.
  const busy = new Set<string>();
  for (const email of input.engaged) {
    const key = normEmail(email ?? null);
    if (key) busy.add(key);
  }

  const free = on.filter((a) => {
    const key = normEmail(a.agent_email);
    // An agent row with no usable email cannot be matched against the busy set,
    // so it is not counted as free. Fail closed: the cost is one understated
    // "free" count, and the alternative is promising an employee an agent we
    // cannot identify.
    return key !== null && !busy.has(key);
  }).length;

  return { state: free > 0 ? 'agents_free' : 'agents_busy', onQueue: on.length, free };
}
