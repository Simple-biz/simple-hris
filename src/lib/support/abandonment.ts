/**
 * Employee Support LIVE CHAT — what happens to a chat nobody answered.
 *
 * **Kane's Q1, 2026-09-19: an unanswered chat BECOMES a ticket** — an `ES-`
 * number, the one-working-day promise, a permanent record
 * (`docs/superpowers/plans/2026-09-19-employee-support-chat.md:24`, task 14).
 * This module is the arithmetic behind that sentence: hand it the open sessions
 * and an instant, get back the list of acts to perform. It is pure — no clock of
 * its own, no network, no Supabase — so every conversion rule is testable
 * without a database, which is the only kind of proof available here (Kane:
 * *"let us stay in local for now"*).
 *
 * THE SWEEP IS LAZY, ON READ. THERE IS NO CRON AND THERE MUST NOT BE ONE.
 * ---------------------------------------------------------------------------
 * `docs/features/INDEX.md:42` — *"Never add a cron"*: every `/api/cron/*` 401s
 * on the fail-closed `CRON_SECRET` gate and the two declared crons have never
 * once run, 0 audit rows, ever. So the conversion happens when somebody reads
 * the queue, exactly as `src/lib/bank-update/otp.ts:181` expires an OTP and
 * `app/api/presence/active/route.ts:30-42` ages out presence. A sweep that
 * never runs is worse than no sweep, because the stale row then *looks*
 * maintained.
 *
 * TWO DIFFERENT WORDS ARE BOTH SPELLED "ABANDONED". THEY ARE NOT THE SAME ACT.
 * ---------------------------------------------------------------------------
 * 1. An **abandoned CLAIM** — an agent took a chat and their browser went away.
 *    The employee is still sitting there. The plan's invariant (`:93-94`) is
 *    unambiguous: *"An abandoned claim returns the employee to their original
 *    rank; the employee never pays for an agent's disconnect."* That is a
 *    RELEASE back to `waiting`, keeping `queued_at`, and it is not a ticket.
 * 2. An **abandoned SESSION** — the EMPLOYEE went quiet and nobody had answered
 *    them. That is the one that becomes an `ES-` ticket.
 *
 * They are driven by two different heartbeats (the agent's `last_heartbeat_at`
 * in `employee_support_chat_agents`, the employee's `last_seen_at` on the
 * session) and they produce two different writes. Collapsing them would either
 * ticket an employee who is still typing or strand one behind a dead agent.
 *
 * WHICH STALE SESSION BECOMES A TICKET, AND WHICH ONE JUST ENDS
 * ---------------------------------------------------------------------------
 * The SQL header is explicit that `status` is the answer and must never be
 * inferred from the stamps
 * (`references/sql/create/2026-09-19_employee_support_chat.sql:57-60`):
 * *"'ended' and 'abandoned' both carry an ended_at; only the status says which
 * one happened, and only 'abandoned' becomes a ticket."* So the rule reads off
 * the status the session was IN when the employee went quiet:
 *
 * * `waiting` — nobody ever picked it up. Unanswered by definition -> **convert**.
 * * `claimed` — an agent took it and never said a word (the first agent message
 *   is what moves a session to `live`; see the agent messages route). Still
 *   unanswered, and arguably worse -> **convert**.
 * * `live`    — a conversation demonstrably happened -> **end**, no ES- number.
 *
 * When that rule is uncertain it fails TOWARD the ticket, deliberately. Minting
 * a ticket for a chat that was in fact answered costs a staffer one click to
 * close it. NOT minting one for a chat that was not answered costs the employee
 * the entire promise Kane made, silently. Those are not comparable, so the
 * doubt is spent on the employee's side.
 *
 * IDEMPOTENCE: THE STATUS FLIP IS THE CLAIM, AND IT IS A COMPARE-AND-SET
 * ---------------------------------------------------------------------------
 * Two agents polling the queue at the same instant must not mint two tickets
 * for one chat. The guard is the same one
 * `app/api/payment-dispatches/route.ts:230-249` uses for money: **stamp the
 * claim FIRST, conditional on the row still being unclaimed**, and treat zero
 * rows back as "somebody else got it".
 *
 * Here the claim IS the status flip:
 *
 *     UPDATE ... SET status = 'abandoned', ended_at = now()
 *      WHERE id = ? AND status IN ('waiting','claimed')   -- the compare
 *
 * The loser gets zero rows and mints nothing. The winner then creates the
 * ticket and stamps it on, and that stamp carries its own condition in its own
 * WHERE clause (`became_ticket_id IS NULL`) — the rule
 * `app/api/contractor/invoices/[id]/route.ts:118-145` states: a check-then-act
 * read must ALSO put its condition in the UPDATE.
 *
 * NOTHING HERE RE-IMPLEMENTS THE DATABASE'S CONSTRAINTS.
 * `..._only_abandoned_becomes_ticket` (SQL `:174-175`) already refuses a
 * `became_ticket_id` on any status but `abandoned`, and
 * `..._became_both_or_neither` (`:155-156`) already refuses half of the stamp.
 * So this module never asks "is it abandoned yet?" before building the stamp,
 * and the caller never writes one of the two columns: the CHECKs are the
 * backstop and duplicating them in TypeScript would create a second, driftable
 * copy of a rule that is already enforced.
 *
 * THE ONE STATE THE FLIP-FIRST ORDER CREATES, AND HOW IT IS CLOSED
 * ---------------------------------------------------------------------------
 * A crash between the flip and the stamp leaves `status = 'abandoned'` with
 * `became_ticket_id IS NULL` — an employee owed a number that nothing will ever
 * hand them. {@link planSweepAction} reports that row as `complete`, at the
 * FRONT of the budget, and the caller finishes the conversion. Re-minting there
 * would be the one unrecoverable mistake, so the ticket is found again rather
 * than guessed at: every converted chat's concern begins with
 * {@link chatTicketMarker}, and {@link chatTicketConcernPattern} is the exact
 * `ILIKE` pattern that finds it. One builder, one matcher, pinned by a test.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ---------------------------------------------------------------------------
 * * **It does not read a clock, a weekday or a timezone.** `hours.ts` answers
 *   *is the desk open*; this answers *has this person gone*. An employee who
 *   walks away at 4:55 PM is gone at 5:05 PM for exactly the same reason they
 *   would be at 11 AM, and making the sweep office-hours-aware would leave a
 *   queue full of ghosts every morning.
 * * **It does not touch `queued_at`.** A position never rises; the trigger
 *   RAISES on any attempt to move it (SQL `:363-369`) and the release path here
 *   deliberately names only the claim columns and the status.
 * * **It does not page anything, or know that it should.** The caller reads the
 *   open set with `selectAllPaged` — PostgREST caps a result set at 1000 rows
 *   with no error (`src/lib/supabase/select-all-paged.ts:4-11`), and a sweep
 *   handed a truncated set silently leaves the tail unswept forever.
 *
 * Plan: docs/superpowers/plans/2026-09-19-employee-support-chat.md (task 14).
 */

import { formatChatSessionNo, type ChatAuthorSide, type ChatSessionStatus } from './chat-types';
import {
  SUPPORT_CONCERN_MAX,
  SUPPORT_REPLY_PROMISE,
  formatSupportTicketNo,
  isSupportCategory,
  type SupportCategory,
} from './types';

/* ────────────────────────── the staleness window ────────────────────────── */

/**
 * How long an employee's `last_seen_at` may go quiet before we accept they have
 * gone. **Five minutes.**
 *
 * DERIVED FROM THE EMPLOYEE'S CADENCE, NOT THE AGENT'S
 * ---------------------------------------------------------------------------
 * The dialog beats every 10s while it is open and every 45s while a session
 * exists but the dialog is shut (`EmployeeSupportChat.tsx:167-168`), and the
 * slow one is the one that has to fit: *"closing the modal does not leave the
 * queue"* (plan `:89-90`), so the employee with the dialog shut is a person
 * legitimately still in the line. Browsers throttle background timers to about
 * one per minute, so the believable beat in the worst LEGITIMATE case is ~60s,
 * not 45s. Five minutes is four of those missed in a row.
 *
 * DELIBERATELY MUCH LONGER THAN `availability.ts`'s `AGENT_STALE_AFTER_MS`
 * (90s), because the two mistakes are not the same size. Calling an agent gone
 * too early costs
 * them one offer they would have taken. Calling an EMPLOYEE gone too early
 * takes a person out of the line they are still watching, ends the conversation
 * they were having, and converts it into a ticket with a one-working-day
 * promise attached — the feature failing while reporting success. A test pins
 * the ordering of the two constants so neither can be "tidied" into the other.
 *
 * Not a per-status window. A `waiting` employee and a `live` one are equally
 * gone after five silent minutes; what differs is what we DO about it, which is
 * {@link planSweepAction}'s job and not this number's.
 */
export const EMPLOYEE_STALE_AFTER_MS = 300_000;

/**
 * How many conversions one read may perform. Conversions are the expensive act
 * — a transcript read, a ticket insert, two guarded updates, a system line and
 * a notification each — and they ride on somebody's GET.
 *
 * Nothing is lost by the cap: the sweep is lazy, the rows it did not reach are
 * still stale on the next read, and {@link SweepPlan.deferred} says out loud
 * how many are waiting. A cap that silently dropped work would be the bug; this
 * one only spreads it.
 */
export const SWEEP_CONVERT_MAX = 10;

/**
 * How many releases and ends one read may perform. Cheap by comparison — one
 * guarded UPDATE each — so the ceiling is higher, and a queue where fifty
 * claims went stale at once is a deploy, not a Tuesday.
 */
export const SWEEP_ACTION_MAX = 50;

/**
 * How long a freshly flipped `abandoned` session is left alone before another
 * reader is allowed to treat it as an interrupted conversion. **One minute.**
 *
 * THE RACE THIS CLOSES
 * ---------------------------------------------------------------------------
 * The flip is a compare-and-set, so exactly one reader wins it and exactly one
 * ticket is minted — but between that flip and the stamp landing, the row is
 * indistinguishable from the crash state {@link SweepAction} calls `complete`.
 * A second reader polling inside that window would try to finish a conversion
 * that is already finishing, and if it could not yet see the winner's ticket it
 * would mint a second one. That is the single outcome this whole design exists
 * to prevent.
 *
 * The winner completes inside its own request — a transcript read, an insert
 * and an update, all in flight already — so a minute is several orders of
 * magnitude more than it needs and still fast enough that a genuine crash is
 * repaired on the next poll rather than the next day.
 */
export const SWEEP_COMPLETE_GRACE_MS = 60_000;

/* ──────────────────────────────── the rows ──────────────────────────────── */

/**
 * One `employee_support_chat_sessions` row, as much of it as the sweep reads.
 *
 * `became_ticket_id` is here and `became_ticket_at` is not, on purpose: the
 * both-or-neither CHECK (SQL `:155-156`) makes the second column carry no
 * information the first does not, and a module that read both would invite a
 * branch on the half-state the database has already made impossible.
 */
export type SweepSessionRow = {
  id: string;
  session_no: number;
  status: ChatSessionStatus;
  work_email: string;
  filed_by_email: string;
  member_name: string | null;
  department: string | null;
  /**
   * What the employee said the chat is ABOUT, asked when they joined the queue
   * (Kane, 2026-09-21). One of the nine `SUPPORT_CATEGORIES`, or `null` when
   * nobody asked — a session from before the picker shipped, which is NOT the
   * same fact as `'other'`.
   *
   * TYPED `string | null` AND NOT `SupportCategory | null`, DELIBERATELY. The
   * column's CHECK admits only the nine
   * (`2026-09-21_employee_support_chat_category.sql`), but this row arrives as
   * JSON from PostgREST and TypeScript cannot check what the wire sent.
   * Narrowing it here would be an assertion dressed as a fact, and the one
   * place it becomes a `SupportCategory` is {@link chatTicketCategory}, which
   * verifies rather than asserts.
   *
   * REQUIRED, not optional, because the caller's select list is the only thing
   * that can forget it: a missing column reads back as `undefined`, every
   * converted chat silently files under `other` again, and nothing anywhere
   * says so. A required field makes the row shape state the requirement out
   * loud — and `chat-sweep.ts`'s `SESSION_SELECT` is what has to carry it.
   */
  category: string | null;
  /** The employee's RANK. Carried only so the ticket can say how long they waited. */
  queued_at: string;
  /** The EMPLOYEE's heartbeat. This is the whole staleness question. */
  last_seen_at: string;
  /**
   * Stamped by 'ended' and 'abandoned' alike. Read here for ONE purpose: to age
   * out {@link SWEEP_COMPLETE_GRACE_MS} on an interrupted conversion. It is
   * never used to decide WHICH of the two happened — that is `status`, and the
   * SQL header (`:57-60`) says so in as many words.
   */
  ended_at: string | null;
  claimed_by: string | null;
  became_ticket_id: string | null;
};

/** One transcript line, as much of it as the ticket body needs. */
export type SweepTranscriptMessage = {
  author_side: ChatAuthorSide;
  author_name: string | null;
  body: string;
  created_at: string;
  /** The screening flag, carried forward onto the ticket. Never shown to the employee. */
  flagged_at?: string | null;
  flag_reason?: string | null;
};

/* ────────────────────────────── the decision ────────────────────────────── */

/** Why a row was left exactly as it is. Diagnostic only — nothing renders it. */
export type SweepKeepReason =
  /** The session is finished and its books are closed. */
  | 'settled'
  /** The employee's heartbeat is inside the window. They are still here. */
  | 'fresh'
  /**
   * A stamp would not parse, or a `claimed` row names no holder (which the
   * CHECK at SQL `:160-161` forbids, but JSON does not). A row we do not
   * understand is never acted on: every act this module authorises takes
   * something away from somebody.
   */
  | 'unreadable'
  /**
   * The claim looks stale but the agents table could not be read, so "is this
   * agent still here" has no answer. Releasing on a guess would yank a chat out
   * from under an agent who is mid-sentence.
   */
  | 'agents_unknown'
  /**
   * Flipped to `abandoned` moments ago — the reader that won the flip is
   * finishing the conversion right now. See {@link SWEEP_COMPLETE_GRACE_MS}.
   */
  | 'in_flight';

/**
 * What the sweep should do about one row. A value, never a finished write, so
 * the rules are provable without a database and the caller owns every UPDATE.
 */
export type SweepAction =
  | { kind: 'keep'; sessionId: string; because: SweepKeepReason }
  /** The AGENT vanished. Back to `waiting`, original rank, both claim columns cleared. */
  | { kind: 'release'; sessionId: string; heldBy: string }
  /** The EMPLOYEE vanished from a conversation that had already started. No ES- number. */
  | { kind: 'end'; sessionId: string }
  /** The EMPLOYEE vanished and nobody had answered. Kane's Q1 — mint the ticket. */
  | { kind: 'convert'; sessionId: string }
  /** Already flipped to `abandoned`, ticket stamp missing. Finish what was started. */
  | { kind: 'complete'; sessionId: string };

/** What the sweep judges a row against. Both fields are required — see below. */
export type SweepContext = {
  /** The instant to judge staleness against. Passed in so the tests can stand still. */
  now: Date;
  /**
   * The lowercased emails of the agents currently on the queue with a live
   * heartbeat — `agentsOnQueue(...)` from `availability.ts`, mapped to emails.
   *
   * **`null` means the agents table could not be read**, and is not the same as
   * an empty set: empty means we looked and nobody is on (so every claim is
   * stale), `null` means we do not know (so no claim is released). Required
   * rather than optional so a caller has to state which it means.
   */
  freshAgents: ReadonlySet<string> | null;
};

/**
 * How long this employee's heartbeat has been quiet, in ms. `null` when the
 * stamp will not parse — which is "no evidence", not "infinitely old", and the
 * caller must not coalesce it into a number.
 *
 * A NEGATIVE age (a stamp in the future, from clock skew between the database
 * and this process) is returned as-is rather than clamped, exactly as
 * `agentHeartbeatAgeMs` does it: it is inside the window either way, so it
 * still reads as fresh, and hiding the sign would hide the skew.
 */
export function employeeIdleMs(row: SweepSessionRow, now: Date): number | null {
  const seen = Date.parse(row.last_seen_at);
  if (!Number.isFinite(seen)) return null;
  return now.getTime() - seen;
}

/**
 * Has this employee gone quiet for longer than we are willing to hold their
 * place? An unparseable stamp answers **false** — fail closed.
 *
 * The window is INCLUSIVE at the top, matching `isAgentOnQueue`'s exclusive
 * freshness test: an idle time of exactly {@link EMPLOYEE_STALE_AFTER_MS} is
 * stale. One boundary, one definition, so the agent's queue view and the
 * employee's own dialog cannot land on different sides of it.
 */
export function isEmployeeStale(row: SweepSessionRow, now: Date): boolean {
  const idle = employeeIdleMs(row, now);
  if (idle === null) return false;
  return idle >= EMPLOYEE_STALE_AFTER_MS;
}

/**
 * The whole decision, for one row.
 *
 * Order matters and is load-bearing:
 *
 * 1. **An interrupted conversion is finished first.** That employee is already
 *    owed a number; everything else can wait a poll.
 * 2. **A settled session is never touched.** `ended`, and `abandoned` with its
 *    ticket stamped, are done.
 * 3. **An unreadable row is never touched.** See {@link SweepKeepReason}.
 * 4. **The EMPLOYEE's heartbeat decides before the agent's.** A stale employee
 *    ends or converts whoever holds the claim; there is no point handing a chat
 *    back to the line for somebody who has left.
 * 5. **Only then** is a claim released for a vanished agent.
 */
export function planSweepAction(row: SweepSessionRow, ctx: SweepContext): SweepAction {
  const keep = (because: SweepKeepReason): SweepAction => ({
    kind: 'keep',
    sessionId: row.id,
    because,
  });

  // 1. The flip landed and the stamp did not. Finish it — see the header.
  //
  //    …but not while the reader that won the flip is still finishing it. An
  //    `ended_at` we cannot read is not a licence to act: the CHECK at SQL
  //    `:168-169` makes a stampless abandoned row impossible, so a row that
  //    reaches here without one is a row we do not understand.
  if (row.status === 'abandoned' && row.became_ticket_id === null) {
    const flippedAt = row.ended_at ? Date.parse(row.ended_at) : Number.NaN;
    if (!Number.isFinite(flippedAt)) return keep('unreadable');
    if (ctx.now.getTime() - flippedAt < SWEEP_COMPLETE_GRACE_MS) return keep('in_flight');
    return { kind: 'complete', sessionId: row.id };
  }
  // 2. Terminal: 'ended', or 'abandoned' already carrying its ES- number.
  if (row.status === 'ended' || row.status === 'abandoned') return keep('settled');

  // 3. A stamp we cannot read is not evidence that anybody left.
  const idle = employeeIdleMs(row, ctx.now);
  if (idle === null) return keep('unreadable');

  // 4. The employee's own heartbeat, ahead of everything about the agent.
  //    Through `isEmployeeStale` and not through `idle` directly, so the
  //    boundary has exactly ONE definition in this file. One re-parse per row
  //    is the price, and it is cheaper than two comparisons that can drift.
  if (isEmployeeStale(row, ctx.now)) {
    // 'live' is the ONLY status that proves a conversation started: the agent's
    // first message is what moves a session out of 'claimed'. Everything else
    // went unanswered, and an unanswered chat is a ticket (Kane's Q1).
    return row.status === 'live'
      ? { kind: 'end', sessionId: row.id }
      : { kind: 'convert', sessionId: row.id };
  }

  // 5. The employee is still here. Is the agent?
  //
  //    Only from 'claimed'. A 'live' chat is NOT released by the sweep even
  //    when its agent's heartbeat has died: the handoff is a compare-and-set on
  //    the CURRENT holder and a deliberate act, and silently pulling a
  //    half-finished conversation back into the line would restart the employee
  //    with a stranger and no explanation.
  if (row.status !== 'claimed') return keep('fresh');

  const holder = (row.claimed_by ?? '').trim().toLowerCase();
  // A 'claimed' row with no holder is illegal (SQL :160-161) and unreleasable:
  // the release is a compare-and-set on the current holder, and there is
  // nothing to compare against.
  if (!holder) return keep('unreadable');

  if (!ctx.freshAgents) return keep('agents_unknown');
  if (ctx.freshAgents.has(holder)) return keep('fresh');

  return { kind: 'release', sessionId: row.id, heldBy: holder };
}

/** Every act one read should perform, grouped and bounded. */
export type SweepPlan = {
  /** Interrupted conversions, finished first. */
  completes: Extract<SweepAction, { kind: 'complete' }>[];
  /** Kane's Q1 — the chats that become ES- tickets. */
  converts: Extract<SweepAction, { kind: 'convert' }>[];
  /** Stale claims handed back to the line at their ORIGINAL rank. */
  releases: Extract<SweepAction, { kind: 'release' }>[];
  /** Conversations that simply stopped. No ES- number. */
  ends: Extract<SweepAction, { kind: 'end' }>[];
  /**
   * Acts the caps pushed past this read. **Not dropped** — the rows are still
   * stale, the next read picks them up, and this number exists so a caller can
   * say so out loud rather than a backlog being invisible.
   */
  deferred: number;
};

/**
 * Plan a whole read's worth of sweeping.
 *
 * Rows are ordered LONGEST-GONE FIRST, so a cap always spends its budget on the
 * people who have been waiting the most — and so two readers planning the same
 * set plan it identically, which keeps the compare-and-set races down to the
 * ones that actually overlap.
 */
export function planSweep(rows: readonly SweepSessionRow[], ctx: SweepContext): SweepPlan {
  const plan: SweepPlan = { completes: [], converts: [], releases: [], ends: [], deferred: 0 };

  // Oldest heartbeat first. An unparseable stamp sorts last; nothing acts on
  // one anyway, and this only has to be a total order, not a truthful one.
  const ordered = [...rows].sort((a, b) => {
    const am = Date.parse(a.last_seen_at);
    const bm = Date.parse(b.last_seen_at);
    const av = Number.isFinite(am) ? am : Number.POSITIVE_INFINITY;
    const bv = Number.isFinite(bm) ? bm : Number.POSITIVE_INFINITY;
    if (av !== bv) return av - bv;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // Completes and converts share one budget: both end in a ticket write, and
  // both are the expensive path.
  const ticketWork: SweepAction[] = [];
  const cheapWork: SweepAction[] = [];

  for (const row of ordered) {
    const action = planSweepAction(row, ctx);
    if (action.kind === 'keep') continue;
    if (action.kind === 'complete' || action.kind === 'convert') ticketWork.push(action);
    else cheapWork.push(action);
  }

  // Stable partition: every `complete` ahead of every `convert`, each still in
  // longest-gone order inside its group. A `complete` is an employee who is
  // ALREADY owed a number, so it takes the budget first.
  const ticketOrdered = [
    ...ticketWork.filter((a) => a.kind === 'complete'),
    ...ticketWork.filter((a) => a.kind === 'convert'),
  ];

  for (const action of ticketOrdered.slice(0, SWEEP_CONVERT_MAX)) {
    if (action.kind === 'complete') plan.completes.push(action);
    else if (action.kind === 'convert') plan.converts.push(action);
  }
  for (const action of cheapWork.slice(0, SWEEP_ACTION_MAX)) {
    if (action.kind === 'release') plan.releases.push(action);
    else if (action.kind === 'end') plan.ends.push(action);
  }

  plan.deferred =
    Math.max(0, ticketOrdered.length - SWEEP_CONVERT_MAX) +
    Math.max(0, cheapWork.length - SWEEP_ACTION_MAX);

  return plan;
}

/* ─────────────────────────── the ticket it becomes ───────────────────────── */

/**
 * The stable head of every converted chat's `concern`, e.g. `[ESC-1043]`.
 *
 * This is a NATURAL KEY, not decoration. A crash between the status flip and
 * the ticket stamp leaves a session that must be completed without re-minting,
 * and this marker is how the already-minted ticket is found again. The closing
 * bracket is what makes it unambiguous: `[ESC-104]` does not prefix
 * `[ESC-1043]`, so a low-numbered session can never adopt a high-numbered
 * session's ticket. Pinned by a test.
 */
export function chatTicketMarker(sessionNo: number): string {
  return `[${formatChatSessionNo(sessionNo)}]`;
}

/**
 * The exact PostgREST `ilike` pattern that finds a converted chat's ticket.
 *
 * Safe to interpolate unescaped: `formatChatSessionNo` emits `ESC-` plus digits
 * (or an em dash), and Postgres `LIKE` treats only `%`, `_` and the escape
 * character specially — none of which can appear here. Square brackets are
 * literal in `LIKE` (they are a `SIMILAR TO` / regex thing), which is precisely
 * why the marker uses them.
 */
export function chatTicketConcernPattern(sessionNo: number): string {
  return `${chatTicketMarker(sessionNo)}%`;
}

/** The label each transcript line carries into the ticket body. */
const SIDE_LABELS: Record<ChatAuthorSide, string> = {
  employee: 'Employee',
  agent: 'Support',
  system: 'System',
};

/**
 * The pointer that replaces whatever did not fit.
 *
 * Deliberately carries no count. A count would have to be reserved for before
 * it is known, and the load-bearing half of this sentence is the pointer: the
 * whole transcript is on the chat session forever (Kane's Q2 — *"the queue
 * entry AND the full transcript persist"*), so nothing is lost, it is one click
 * away, and the staffer is told where.
 */
function truncationNotice(sessionNo: number): string {
  return `\n…truncated — the full transcript is kept on chat ${formatChatSessionNo(sessionNo)}.`;
}

/** One transcript line as the ticket renders it. `Support (Carla): …` */
function transcriptLine(message: SweepTranscriptMessage): string {
  const side = SIDE_LABELS[message.author_side] ?? 'Message';
  const name = message.author_name?.trim();
  // The employee's own name is already on the ticket row (`member_name`), so
  // repeating it on every line of their own transcript is noise. An AGENT's
  // name is not on the row at all and is the thing a reader wants.
  const label = name && message.author_side === 'agent' ? `${side} (${name})` : side;
  return `${label}: ${message.body.trim()}`;
}

/**
 * The ticket's `concern` — the transcript, with a head that says how it got here.
 *
 * **Never empty and never over {@link SUPPORT_CONCERN_MAX}.** Both are CHECK
 * constraints on `employee_support_tickets` (`..._concern_present` and
 * `..._concern_bounded`, `2026-09-16_employee_support.sql:139-144`), and a
 * violation of either is a 500 on a path whose entire purpose is to keep a
 * promise to somebody who has already been let down once. The empty case is
 * real: an employee can enter the queue, wait, and never type a word.
 */
export function buildChatTicketConcern(input: {
  sessionNo: number;
  queuedAt: string;
  messages: readonly SweepTranscriptMessage[];
}): string {
  const marker = chatTicketMarker(input.sessionNo);
  const head =
    `${marker} Unanswered live chat — converted to a ticket automatically.\n` +
    `Queued ${input.queuedAt}. Nobody was able to pick it up before the chat went quiet.`;

  if (input.messages.length === 0) {
    return `${head}\n\nThe employee did not type anything before the chat went quiet.`;
  }

  const notice = truncationNotice(input.sessionNo);
  const budget = SUPPORT_CONCERN_MAX - head.length - notice.length;

  let body = '';
  let taken = 0;
  for (const message of input.messages) {
    const line = `\n${transcriptLine(message)}`;
    if (body.length + line.length > budget) break;
    body += line;
    taken += 1;
  }

  if (taken === input.messages.length) return `${head}\n${body.trimStart()}`;

  // Nothing whole fits — one very long first message. Show its beginning rather
  // than nothing at all: the opening of a question is the part that identifies
  // it, and the staffer is pointed at the full text on the next line.
  if (taken === 0) {
    // `budget` already excludes the head and the notice. Two more characters
    // leave the file's return statement room for the newline it re-adds after
    // `trimStart` and for the ellipsis — the arithmetic is off by one without
    // them, and a 4001-character concern is a CHECK violation, not a rounding
    // error. `abandonment.test.ts` pins the exact boundary.
    const room = budget - 2;
    if (room > 40) body = `\n${transcriptLine(input.messages[0]).slice(0, room)}…`;
  }

  return `${head}\n${body.trimStart()}${notice}`;
}

/**
 * The `employee_support_tickets` insert an abandoned chat becomes.
 *
 * Note what is absent: `status`, `claimed_by`, `claimed_at`, `first_response_at`.
 * The column default owns the first (`'open'`) and the rest must stay NULL —
 * nobody has picked this up, which is the entire reason it exists. Writing them
 * here is how a ticket ends up claimed by the agent who happened to be polling.
 */
export type ChatTicketDraft = {
  work_email: string;
  filed_by_email: string;
  member_name: string | null;
  department: string | null;
  category: SupportCategory;
  concern: string;
  flagged_at: string | null;
  flag_reason: string | null;
};

/**
 * What a converted chat files under when the session never knew its subject.
 *
 * THIS USED TO BE THE ANSWER. IT IS NOW THE FALLBACK.
 * ---------------------------------------------------------------------------
 * Until 2026-09-21 the chat had no category picker, so every converted chat was
 * filed as `other` — `'Something else'` (`types.ts:49`) — and the board could
 * not tell a pay dispute from a Roboform lockout without opening the
 * transcript. Kane: *"The chat support option should ask the Employees what
 * issue is it about"*, so the session now carries one and the ticket
 * {@link buildChatTicket} mints INHERITS it.
 *
 * `other` survives for the two cases that are real and always will be:
 *
 * * **Nobody asked.** A session that predates the picker, or one opened by a
 *   path that does not collect a category. `null` on the row.
 * * **Something arrived that is not one of the nine.** See
 *   {@link chatTicketCategory} — that case must land somewhere, and it must
 *   never land on the ticket table's CHECK.
 *
 * It is NOT deleted and NOT inlined: it is the value two other modules compare
 * against, and a bare `'other'` string spread through the conversion path is
 * how a fallback becomes unfindable.
 */
export const CHAT_TICKET_CATEGORY: SupportCategory = 'other';

/**
 * The session's category, turned into one the ticket table will accept.
 *
 * THIS IS A GUARD, NOT A MAPPING, AND IT IS THE POINT OF THE WHOLE FUNCTION.
 * ---------------------------------------------------------------------------
 * `employee_support_tickets.category` is `not null` under
 * `employee_support_tickets_category_valid`
 * (`2026-09-16_employee_support.sql:68-81`). An unrecognised value reaching
 * that insert is a CHECK violation, which is a 500 on the conversion path —
 * and a failed conversion means an employee who was already let down once
 * silently never gets their `ES-` number. So nothing that is not provably one
 * of the nine is ever handed to it.
 *
 * Takes `unknown` on purpose. The row is JSON off the wire: the column can be
 * absent entirely (a select list that forgot it), `null`, a value from a
 * future migration this deploy has not heard of, or something a different
 * writer put there. All of them are the same answer here.
 *
 * NOTHING IS COERCED. `'  pay_payslip  '`, `'PAY_PAYSLIP'` and `'salary'` all
 * file as {@link CHAT_TICKET_CATEGORY}, because trimming or lower-casing a
 * near-miss is guessing at what somebody meant, and the database refuses those
 * values at the session door anyway (the normalize trigger deliberately does
 * not touch this column). A category that arrives malformed is a bug in the
 * writer; filing it as "Something else" keeps the employee's ticket while
 * leaving the bug visible in the row.
 */
export function chatTicketCategory(value: unknown): SupportCategory {
  return isSupportCategory(value) ? value : CHAT_TICKET_CATEGORY;
}

/**
 * Build the ticket. Identity is copied from the SESSION, which took it from
 * `authz.effectiveEmail` when the chat was opened — never from anything a
 * request said since. The CATEGORY comes from the session too, for the same
 * reason and with one extra one: it is the employee's own answer to *"what is
 * this about"*, and the ticket is the durable record of the question they
 * asked. Re-deriving it from the transcript would be a classifier overruling
 * the person who typed it.
 */
export function buildChatTicket(input: {
  session: SweepSessionRow;
  messages: readonly SweepTranscriptMessage[];
}): ChatTicketDraft {
  const concern = buildChatTicketConcern({
    sessionNo: input.session.session_no,
    queuedAt: input.session.queued_at,
    messages: input.messages,
  });

  // The screening flag follows the question onto the ticket. It is a note to
  // whoever opens it and never reaches the employee — the same rule the chat
  // and ticket tables both state, and the reason a flag never blocks.
  //
  // Both columns are derived from the ONE found message, so the
  // `..._flag_both_or_neither` CHECK holds by construction rather than by two
  // expressions somebody has to keep agreeing.
  const flagged = input.messages.find((m) => !!m.flagged_at?.trim() && !!m.flag_reason?.trim());

  return {
    work_email: input.session.work_email,
    filed_by_email: input.session.filed_by_email,
    member_name: input.session.member_name,
    department: input.session.department,
    // The employee's own answer, or `other` when there was not one. Never the
    // raw value: `chatTicketCategory` is what stands between an unrecognised
    // string and a CHECK violation on the insert below.
    category: chatTicketCategory(input.session.category),
    concern,
    // The ORIGINAL stamp, not `now`: the flag was raised when the message was
    // typed, and re-dating it would make the ticket claim the screen ran at
    // conversion time.
    flagged_at: flagged ? (flagged.flagged_at as string) : null,
    flag_reason: flagged
      ? `From live chat ${formatChatSessionNo(input.session.session_no)}: ${flagged.flag_reason}`
      : null,
  };
}

/* ──────────────────────────── what people are told ───────────────────────── */

/**
 * The `system` line that closes the chat transcript.
 *
 * Written by NOBODY — `author_email` is NULL, which the side CHECK requires
 * (SQL `:267`) — because "this became a ticket" is not something the agent who
 * happened to be polling said, and attributing it to a named person inside a
 * record that becomes a ticket puts words in their mouth. It is a line in the
 * conversation rather than chrome around it, which is the reason the `system`
 * side exists at all (`chat-types.ts:40-46`).
 */
export function becameTicketSystemLine(ticketNo: number | null): string {
  const label = formatSupportTicketNo(ticketNo);
  return `Nobody was able to pick this chat up, so it became ticket ${label}. Support will reply ${SUPPORT_REPLY_PROMISE}.`;
}

/**
 * The in-app notification an employee gets. `support_chat.became_ticket`.
 *
 * This is *"the only thing standing between an unanswered chat and an employee
 * who thinks they were ignored"*
 * (`references/sql/alter/2026-09-19_add_chat_notification_types.sql:5-9`), so
 * it leads with the promise rather than with the failure. The word "abandoned"
 * never reaches the person who waited — nobody abandoned them
 * (`chat-types.ts:56-59`).
 */
export function becameTicketNotification(input: { sessionNo: number; ticketNo: number | null }): {
  title: string;
  message: string;
} {
  const ticket = formatSupportTicketNo(input.ticketNo);
  return {
    title: `Your chat is now ticket ${ticket}`,
    message:
      `Nobody was free to pick up your live chat, so everything you wrote has been kept as ticket ${ticket}. ` +
      `Support will reply ${SUPPORT_REPLY_PROMISE} — you do not need to ask again.`,
  };
}

/** The `system` line for a claim that was handed back because the agent vanished. */
export function releasedSystemLine(): string {
  return 'The agent disconnected, so this chat went back to the queue — you kept your place in line.';
}

/** The `system` line for a conversation that simply stopped. */
export function endedSystemLine(): string {
  return 'This chat closed after a long silence.';
}
