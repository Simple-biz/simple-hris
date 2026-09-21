/**
 * Employee Support LIVE CHAT — the lazy sweep, and the reads it rides on.
 *
 * Plan: docs/superpowers/plans/2026-09-19-employee-support-chat.md (task 14).
 * Lifted out of app/api/support/chat/queue/route.ts on 2026-09-21.
 *
 * WHY THIS IS A MODULE AND NOT A ROUTE HELPER
 * ---------------------------------------------------------------------------
 * Kane's Q1 is that an unanswered chat BECOMES a ticket. While the sweep lived
 * inside the agent queue route it had exactly one caller, so the promise fired
 * only when an agent happened to open /tickets — and the chats that go
 * unanswered are precisely the ones nobody is watching. An employee could wait,
 * go quiet, and learn nothing until somebody opened the board on Monday. The
 * one read that would have rescued them was the read that never ran.
 *
 * A Next.js route module cannot export a helper, so the fix is this file: both
 * the agent queue GET and THE EMPLOYEE'S OWN GET call `sweepChatQueue`, which
 * means an employee checking their own place is enough to convert it. That is
 * the read that always happens.
 *
 * There is still no cron and there must not be one: `docs/features/INDEX.md:42`
 * — every `/api/cron/*` 401s on the fail-closed `CRON_SECRET` gate and the two
 * declared crons have never once run. Expiry is lazy, on read, the way
 * `src/lib/bank-update/otp.ts:181` expires an OTP.
 *
 * The RULES are in `abandonment.ts` and are pure. This file is the I/O around
 * them, kept deliberately thin — `.env.local` holds only `.env.example`
 * placeholders (Kane: "let us stay in local for now"), so a rule that can only
 * be proved against production cannot be proved here at all.
 *
 * TWO GUARDS THAT MUST NOT BE SOFTENED
 * ---------------------------------------------------------------------------
 * 1. Every status flip re-asserts `last_seen_at < staleCutoff` in its own WHERE.
 *    The plan decides staleness once; the writes can land seconds later, and in
 *    that window an employee can come back. Without the predicate the sweep
 *    converts a live person's chat while they are watching it.
 * 2. The `completes` path takes a LEASE before finishing an interrupted
 *    conversion. It is the one path with no status flip to ride on, so two
 *    concurrent readers would otherwise both mint an `ES-` ticket for one
 *    question — the single outcome this whole design exists to prevent.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthzOk } from '@/lib/auth/authorize-email';
import { auditFrom } from '@/lib/audit/context';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { classifyTableProbe } from '@/lib/db/probe-verdict';
import { normEmail } from '@/lib/email/norm-email';
import { broadcastFromServer } from '@/lib/supabase/realtime-broadcast';
import { recordNotifyFailure } from '@/lib/notifications/notify-failure-audit';
import { CHAT_LIVE_EVENT, CHAT_LIVE_TOPIC, type ChatLivePayload } from '@/lib/support/chat-live';
import {
  CHAT_OPEN_STATUSES,
  formatChatSessionNo,
  type ChatSessionStatus,
} from '@/lib/support/chat-types';
import { formatSupportTicketNo } from '@/lib/support/types';
import { agentsOnQueue, type ChatAgentRow } from '@/lib/support/availability';
import {
  EMPLOYEE_STALE_AFTER_MS,
  becameTicketNotification,
  becameTicketSystemLine,
  buildChatTicket,
  chatTicketConcernPattern,
  endedSystemLine,
  planSweep,
  releasedSystemLine,
  type SweepPlan,
  type SweepSessionRow,
  type SweepTranscriptMessage,
} from '@/lib/support/abandonment';

export const SESSIONS_TABLE = 'employee_support_chat_sessions';
export const MESSAGES_TABLE = 'employee_support_chat_messages';
export const AGENTS_TABLE = 'employee_support_chat_agents';
export const TICKETS_TABLE = 'employee_support_tickets';

/**
 * The three OPEN statuses, typed against the vocabulary module rather than
 * restated as bare strings — a status renamed there must not survive here as a
 * literal that silently matches nothing. Same constant the partial indexes are
 * scoped to (SQL `:198`, `:222`).
 */
export const OPEN_STATUSES = [...CHAT_OPEN_STATUSES] as ChatSessionStatus[];

/**
 * Every column the sweep and the agent list need, read once and used by both.
 * `SweepSessionRow` is the shape `abandonment.ts` declares, so the select and
 * the pure module cannot drift apart without the compiler saying so.
 */
export const SESSION_SELECT =
  'id, session_no, status, work_email, filed_by_email, member_name, department, category, queued_at, last_seen_at, ended_at, claimed_by, claimed_at, became_ticket_id';

export type ChatSessionRow = SweepSessionRow & { claimed_at: string | null };

/** What one read's sweep actually did. Reported so a backlog is never silent. */
export type SweepReport = {
  converted: number;
  completed: number;
  released: number;
  ended: number;
  /** Acts the caps pushed to the next read. The rows are still stale, not lost. */
  deferred: number;
  /** Conversions that could not be finished. Also written to `audit_log`. */
  failed: number;
};

export const NO_SWEEP: SweepReport = { converted: 0, completed: 0, released: 0, ended: 0, deferred: 0, failed: 0 };

/** The FACT that a session moved. Never the content — see `chat-live.ts`. */
export function announce(sessionId: string, kind: ChatLivePayload['kind']): void {
  // A declared interface carries no index signature, so the literal is spread
  // fresh into the `Record<string, unknown>` the broadcaster takes; `satisfies`
  // keeps it checked against the contract rather than cast past it.
  void broadcastFromServer(CHAT_LIVE_TOPIC, CHAT_LIVE_EVENT, {
    ...({ kind, sessionId, ts: Date.now() } satisfies ChatLivePayload),
  });
}

/**
 * A `system` line on the transcript. Written by NOBODY — `author_email` is
 * NULL, which the side CHECK requires (SQL `:267`) — because "the agent
 * disconnected" is not something a named person said, inside a record that may
 * become a ticket.
 *
 * Best-effort and knowingly so: the act it narrates is already committed, a
 * returned PostgREST error is discarded and the catch covers a transport
 * failure. A transcript missing a line is a smaller wrong than an act that
 * reports failure after it happened.
 */
export async function systemLine(sb: SupabaseClient, sessionId: string, body: string): Promise<void> {
  try {
    await sb.from(MESSAGES_TABLE).insert({
      session_id: sessionId,
      author_side: 'system',
      author_email: null,
      author_name: null,
      body,
    });
  } catch {
    /* see above */
  }
}

/* ───────────────────────────────── reads ────────────────────────────────── */

/** Every open session, in one paged read. `migrated:false` when the table is absent. */
export async function readOpenSessions(
  sb: SupabaseClient,
): Promise<{ rows: ChatSessionRow[]; error: string | null; migrated: boolean }> {
  const { rows, error } = await selectAllPaged<ChatSessionRow>((from, to) =>
    sb
      .from(SESSIONS_TABLE)
      .select(SESSION_SELECT)
      .in('status', OPEN_STATUSES)
      .order('queued_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (error) {
    if (classifyTableProbe({ message: error }) === 'MISSING') {
      return { rows: [], error: null, migrated: false };
    }
    return { rows: [], error, migrated: true };
  }
  return { rows, error: null, migrated: true };
}

/**
 * The interrupted conversions: flipped to `abandoned`, never stamped.
 *
 * A separate read from the open set because they are no longer open — and the
 * partial index the open read rides on is scoped to the three open statuses
 * (SQL `:222`), so folding them into one `.or()` would give up the index for a
 * set that is empty on every healthy day.
 *
 * `null` on failure: an unreadable recovery set is not an empty one, and the
 * sweep must not conclude "nothing to repair" from a read it could not do.
 *
 * NO INDEX COVERS THIS PREDICATE. The chat SQL ships four partial indexes and
 * none is scoped to `status = 'abandoned' AND became_ticket_id IS NULL`, so this
 * is a scan of the sessions table on every queue poll. It is correct and it is
 * cheap while the table is small; a
 * `create index ... (ended_at) where status = 'abandoned' and became_ticket_id is null`
 * belongs in the next migration and is named here so it is not rediscovered as
 * a mystery on the day the table is large.
 */
export async function readUnstampedAbandoned(sb: SupabaseClient): Promise<ChatSessionRow[] | null> {
  const { rows, error } = await selectAllPaged<ChatSessionRow>((from, to) =>
    sb
      .from(SESSIONS_TABLE)
      .select(SESSION_SELECT)
      .eq('status', 'abandoned')
      .is('became_ticket_id', null)
      .order('ended_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  return error ? null : rows;
}

/**
 * The agents table. `null` when it could not be read — which `availability.ts`
 * and `abandonment.ts` both treat as UNKNOWN rather than as "nobody is on", and
 * the difference decides whether a claim is released.
 *
 * Paged even though this table holds one row per named agent and Kane granted
 * five: `selectAllPaged` is a single request below 1000 rows, so the safety is
 * free and the habit is the rule (`select-all-paged.ts:4-11`).
 */
export async function readAgents(sb: SupabaseClient): Promise<ChatAgentRow[] | null> {
  const { rows, error } = await selectAllPaged<ChatAgentRow>((from, to) =>
    sb
      .from(AGENTS_TABLE)
      .select('agent_email, agent_name, on_queue, on_queue_since, last_heartbeat_at')
      .order('agent_email', { ascending: true })
      .range(from, to),
  );
  return error ? null : rows;
}

/** One session's transcript, oldest first. A transcript is a SET, so it pages. */
export async function readTranscript(
  sb: SupabaseClient,
  sessionId: string,
): Promise<SweepTranscriptMessage[] | null> {
  const { rows, error } = await selectAllPaged<SweepTranscriptMessage>((from, to) =>
    sb
      .from(MESSAGES_TABLE)
      .select('author_side, author_name, body, created_at, flagged_at, flag_reason')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  return error ? null : rows;
}

/* ────────────────────────────── the sweep ───────────────────────────────── */

/* ──────────────────────── the two reasons for a ticket ──────────────────── */

/**
 * WHY this chat is becoming a ticket. Two acts, ONE minting path.
 *
 * `expired`   — the lazy sweep. Nobody answered, the session is already
 *               `abandoned`, and the ticket is the promise being kept.
 * `addressed` — Kane, 2026-09-21: *"they can click to address that concern and
 *               if they address that concern it should be able to start the
 *               ticket."* An agent took the chat and the ticket is the durable
 *               record of the question, opened while the conversation is still
 *               happening.
 *
 * They differ in three things and in nothing else — the copy, the audit action,
 * and whether the session is stamped (see THE STAMP below). Everything that
 * decides WHICH ticket exists is shared, because two minting paths is how one
 * question ends up with two `ES-` numbers, and `abandonment.ts:178-193` calls
 * that the single outcome this design exists to prevent.
 */
export type ConversionKind = 'expired' | 'addressed';

/** What a conversion attempt actually produced. */
export type ConversionResult = {
  /** The ticket exists and the employee has been told, or was told already. */
  ok: boolean;
  ticketId: string | null;
  ticketNo: number | null;
  /** TRUE only when THIS call inserted the row. False = it attached to one already there. */
  minted: boolean;
};

/**
 * Nothing was written and no ticket exists. Frozen: a shared singleton a caller
 * mutated would poison every later conversion, the same reason
 * `triage.ts`'s `COUNTS_UNRESOLVED` is frozen.
 */
export const NO_CONVERSION: Readonly<ConversionResult> = Object.freeze({
  ok: false,
  ticketId: null,
  ticketNo: null,
  minted: false,
});

/**
 * The `system` line an ADDRESSED chat gets, and the sibling of
 * `becameTicketSystemLine` (`abandonment.ts`).
 *
 * WHY THE COPY LIVES HERE AND NOT THERE. `abandonment.ts` is the ABANDONMENT
 * vocabulary — the words a chat hears when *nobody answered*, written so that
 * "abandoned" never reaches the person who waited. This is the opposite case:
 * somebody DID answer, on purpose, in the same minute. Filing its wording under
 * abandonment would put two contradictory meanings in one module and invite a
 * later edit to "unify" them.
 *
 * It says both true things — *you are being helped* and *there is a number* —
 * because an employee who reads only the second one has been told their live
 * chat turned into a queue ticket, which is what happens when nobody comes.
 *
 * Written by NOBODY (`author_email` NULL, the side CHECK at SQL `:267`): the
 * agent is about to speak for themselves and this is not their sentence.
 */
export function addressedSystemLine(ticketNo: number | null): string {
  const label = formatSupportTicketNo(ticketNo);
  return (
    `Somebody from Support has picked this up and is with you now. ` +
    `Everything you wrote is also kept as ticket ${label}, so nothing is lost when the chat ends.`
  );
}

/**
 * The in-app notification for an addressed chat.
 *
 * Deliberately the EXISTING `support_chat.became_ticket` type and not a new
 * one: the type list is a CHECK constraint that needs DDL to widen, a dead
 * notification type looks exactly like a delivered one
 * (`notify-failure-audit.ts:4-12`), and this event is the same event that type
 * already names — *your chat now has a ticket number*. Only the words differ,
 * because the reason does.
 */
export function addressedNotification(input: { sessionNo: number; ticketNo: number | null }): {
  title: string;
  message: string;
} {
  const ticket = formatSupportTicketNo(input.ticketNo);
  return {
    title: `Support picked up your chat — ticket ${ticket}`,
    message:
      `Somebody from Support is looking at your live chat ${formatChatSessionNo(input.sessionNo)} right now. ` +
      `Everything you wrote is also kept as ticket ${ticket}, so the record stays after the chat ends.`,
  };
}

/**
 * Finish a conversion: find or mint the ticket, stamp it on, tell the employee.
 *
 * **IT LOOKS THE TICKET UP BEFORE MINTING ONE.** `chatTicketConcernPattern` is
 * the exact `ILIKE` for the marker `buildChatTicket` writes into every converted
 * concern, and that lookup is what makes a repeat of this function safe: a
 * session whose ticket already exists is stamped, never re-ticketed. Minting a
 * second `ES-` number for one question is the single unrecoverable mistake on
 * this path — the employee is then promised twice and answered once.
 *
 * It is also what makes the `addressed` caller safe against the sweep and
 * against itself: pressing Address twice, or an addressed chat later expiring,
 * finds the one ticket and attaches to it.
 *
 * THE STAMP, AND THE ONE THING THE ADDRESSED PATH CANNOT DO TODAY
 * ---------------------------------------------------------------------------
 * `became_ticket_id`/`became_ticket_at` are the session's receipt. The write
 * carries its own condition (`became_ticket_id IS NULL`) in its own WHERE
 * clause, so two callers racing produce one stamp and one no-op rather than a
 * last-writer-wins overwrite.
 *
 * ⚠ It runs for `expired` ONLY, because the database forbids the other case:
 * `employee_support_chat_sessions_only_abandoned_becomes_ticket`
 * (`2026-09-19_employee_support_chat.sql:174-175`) is
 * `check (became_ticket_id is null or status = 'abandoned')`, and an ADDRESSED
 * session is `claimed`/`live` — it is being answered, and `abandoned` is
 * reserved for the expiry path because only it carries the "nobody answered
 * you" meaning. Stamping an addressed session would be rejected by that CHECK
 * *after* the ticket was already minted.
 *
 * **The rule is NOT loosened here to make it fit.** The addressed link is
 * carried the other way round instead — by the `[ESC-nnnn]` marker
 * `buildChatTicket` writes into the ticket's own concern, which is exactly what
 * the lookup above reads, so idempotence never depended on the stamp. What is
 * missing is only the REVERSE pointer: a session row cannot yet say which
 * ticket it started, so the queue cannot show the number after a reload. That
 * needs one migration and a decision Kane owns — widen the CHECK, or give the
 * session a separate nullable `ticket_id` meaning *"the ticket this chat is
 * recorded in"* (the cleaner of the two: `became_*` says the chat ENDED as a
 * ticket, which an ongoing conversation has not). Until then this returns the
 * ids to its caller and writes no half-state.
 *
 * TELLING THE EMPLOYEE HAPPENS AT MOST ONCE, AND THE GATE DIFFERS BY KIND.
 * For `expired` it is the stamp landing — the winner of the race speaks. For
 * `addressed` there is no stamp to win, so it is `minted`: whoever inserted the
 * row is the one who tells them, and a second Address attaches in silence.
 */
export async function completeConversion(
  sb: SupabaseClient,
  request: Request,
  authz: AuthzOk,
  session: ChatSessionRow,
  kind: ConversionKind = 'expired',
): Promise<ConversionResult> {
  const messages = await readTranscript(sb, session.id);
  // An unreadable transcript is not an empty one. Minting a ticket that claims
  // "the employee did not type anything" when in fact we could not read what
  // they typed would put a falsehood into the permanent record — and the next
  // read retries this for free.
  if (!messages) return { ...NO_CONVERSION };

  let ticketId: string | null = null;
  let ticketNo: number | null = null;

  const existing = await sb
    .from(TICKETS_TABLE)
    .select('id, ticket_no')
    .eq('work_email', session.work_email)
    .ilike('concern', chatTicketConcernPattern(session.session_no))
    .order('created_at', { ascending: true })
    .limit(1);
  if (existing.error) return { ...NO_CONVERSION };

  const found = (existing.data?.[0] as { id: string; ticket_no: number } | undefined) ?? null;
  if (found) {
    ticketId = found.id;
    ticketNo = found.ticket_no;
  } else {
    const inserted = await sb
      .from(TICKETS_TABLE)
      .insert(buildChatTicket({ session, messages }))
      .select('id, ticket_no')
      .limit(1);
    if (inserted.error) return { ...NO_CONVERSION };
    const row = (inserted.data?.[0] as { id: string; ticket_no: number } | undefined) ?? null;
    if (!row) return { ...NO_CONVERSION };
    ticketId = row.id;
    ticketNo = row.ticket_no;
  }

  /** The ticket is ours to announce only if this call is the one that made it. */
  const minted = !found;
  const result: ConversionResult = { ok: true, ticketId, ticketNo, minted };

  /** Who gets to tell the employee. See TELLING THE EMPLOYEE in the header. */
  let speaks = minted;

  if (kind === 'expired') {
    // The stamp. Both columns move as one act — `..._became_both_or_neither`
    // (SQL :155-156) — and the status is NOT re-asserted here: the CHECK
    // `..._only_abandoned_becomes_ticket` (:174-175) already refuses this write
    // on any other status, and a second copy of that rule in TypeScript is a
    // second thing to keep true. It is also why this block is `expired` only —
    // see THE STAMP in the header.
    const stamped = await sb
      .from(SESSIONS_TABLE)
      .update({ became_ticket_id: ticketId, became_ticket_at: new Date().toISOString() })
      .eq('id', session.id)
      .is('became_ticket_id', null)
      .select('id');
    // The ticket exists either way, so the ids go back; `ok: false` is what
    // makes the sweep count this a failure and retry on the next read, which
    // the lookup above makes free.
    if (stamped.error) return { ...result, ok: false };
    // Zero rows: somebody else stamped it between our read and this write. The
    // ticket we may have just minted is theirs to have found; nothing is written
    // twice and nothing is told to the employee twice.
    speaks = !!stamped.data && stamped.data.length > 0;
  }

  if (!speaks) return result;

  await systemLine(
    sb,
    session.id,
    kind === 'addressed' ? addressedSystemLine(ticketNo) : becameTicketSystemLine(ticketNo),
  );

  const { title, message } =
    kind === 'addressed'
      ? addressedNotification({ sessionNo: session.session_no, ticketNo })
      : becameTicketNotification({ sessionNo: session.session_no, ticketNo });
  // `null` never `''` — an empty recipient is the Gmail-node failure this house
  // rule exists for (`docs/features/tickets-board.md:109-112`), and an empty
  // `recipient_email` here is a row nobody can ever read.
  const recipient = normEmail(session.work_email);
  if (recipient) {
    const notif = await sb.from('employee_notifications').insert({
      recipient_email: recipient,
      type: 'support_chat.became_ticket',
      tone: 'neutral',
      title,
      message,
      details: {
        session_id: session.id,
        session_no: session.session_no,
        ticket_id: ticketId,
        ticket_no: ticketNo,
      },
    });
    if (notif.error) {
      // NOT a console line. `kpi.scored` delivered nothing for three days
      // because a CHECK rejection looked identical to success
      // (`notify-failure-audit.ts:4-12`), and `support_chat.became_ticket` is
      // rejected by exactly that constraint until task 16's DDL runs.
      void recordNotifyFailure({
        notificationType: 'support_chat.became_ticket',
        origin: kind === 'addressed' ? 'support/chat/queue address' : 'support/chat/queue sweep',
        error: notif.error,
        actor: { user_name: authz.sessionEmail, user_role: authz.roles[0] ?? 'user' },
        details: { session_no: session.session_no, ticket_no: ticketNo },
      });
    }
  }

  void insertAuditLog({
    ...auditFrom(request, authz),
    action:
      kind === 'addressed'
        ? 'employee_support.chat.addressed'
        : 'employee_support.chat.became_ticket',
    resource: SESSIONS_TABLE,
    resource_id: session.id,
    details: {
      session_no: session.session_no,
      ticket_no: ticketNo,
      work_email: session.work_email,
      // The sweep is nobody's decision — it is the passage of time. The actor
      // on the row is whoever's read happened to run it, which is the truth
      // about who touched the data and deliberately not a claim that they
      // chose to. An ADDRESS is the opposite: somebody chose it, and the same
      // actor columns then mean what they appear to mean.
      ...(kind === 'addressed' ? { addressed: true } : { swept_by_read: true }),
    },
  });

  return result;
}

/**
 * Run the lazy sweep. Idempotent, bounded, and safe to call from any read.
 *
 * NOT exported, and not because it should not be shared: a Next.js route module
 * may only export the HTTP handlers and the route segment config, so a second
 * caller means lifting this function into `src/lib/support/` first. That is the
 * work the KNOWN GAP in this file's header describes, and it is one move rather
 * than a rewrite — every rule it applies is already in `abandonment.ts`, and
 * what is left here is the reads and the guarded writes.
 *
 * It never throws: a sweep that failed must not fail the read it rode in on.
 */
export async function sweepChatQueue(
  sb: SupabaseClient,
  request: Request,
  authz: AuthzOk,
  input: { open: ChatSessionRow[]; agents: ChatAgentRow[] | null },
): Promise<SweepReport> {
  const report: SweepReport = { ...NO_SWEEP };
  const now = new Date();

  const orphans = await readUnstampedAbandoned(sb);
  // `null` means the recovery read failed. The open set is still sweepable, and
  // an interrupted conversion is repaired on the next read — never inferred to
  // be absent from a read that did not happen.
  const rows: ChatSessionRow[] = [...input.open, ...(orphans ?? [])];

  const onQueue = agentsOnQueue(input.agents, now);
  const freshAgents = onQueue
    ? new Set(onQueue.map((a) => normEmail(a.agent_email)).filter((e): e is string => !!e))
    : null;

  const plan: SweepPlan = planSweep(rows, { now, freshAgents });
  report.deferred = plan.deferred;

  const byId = new Map(rows.map((r) => [r.id, r]));
  const nowIso = now.toISOString();

  /**
   * The instant a session must not have been seen since, for a flip to be
   * authorised. Computed ONCE from the same `now` the plan was built from, so
   * the guard in the WHERE and the decision in `planSweep` cannot disagree.
   *
   * WHY IT IS IN THE WHERE AND NOT ONLY IN THE PLAN. `isEmployeeStale` is
   * evaluated at plan time, and the plan can queue up to SWEEP_CONVERT_MAX
   * conversions, each doing a transcript read, a ticket lookup, an insert, two
   * updates and a notification, sequentially. The last flip can therefore
   * execute seconds after `now` was captured — and in that window the employee's
   * own GET beats `last_seen_at`, because they came back. Without this
   * predicate the flip would convert a live person's chat and mint them an ES-
   * ticket while they were watching it. A check-then-act read must ALSO carry
   * its condition into the UPDATE's WHERE clause; the rule and its reasoning
   * are at app/api/contractor/invoices/[id]/route.ts:118-145.
   */
  const staleCutoff = new Date(now.getTime() - EMPLOYEE_STALE_AFTER_MS).toISOString();

  // 1. Interrupted conversions first — that employee is already owed a number.
  //
  //    TAKE A LEASE BEFORE COMPLETING. The convert path below is safe because
  //    its status flip IS a compare-and-set, but this path has no flip to ride
  //    on: the row is ALREADY `abandoned` and already unstamped, which is
  //    exactly the state two readers can agree on. Two agents' 10s polls
  //    landing together would both read it, both find no existing ticket by
  //    `chatTicketConcernPattern`, and both insert — one stamps, the other's
  //    `became_ticket_id IS NULL` guard no-ops, and a SECOND orphaned ES-
  //    ticket is left in the support queue carrying the one-working-day promise
  //    for a question already answered. `abandonment.ts:178-193` calls minting
  //    two numbers for one question the single outcome this design exists to
  //    prevent, so it cannot be left to the grace window alone.
  //
  //    The lease is a conditional touch of `ended_at`: it renews the winner's
  //    SWEEP_COMPLETE_GRACE_MS and, because the WHERE pins the exact value just
  //    read, the loser gets zero rows and stops. `ended_at` is writable — the
  //    trigger freezes only `queued_at` (SQL :363-369) — and the status and
  //    stamp conditions ride along so a row finished between the read and here
  //    is skipped too.
  for (const action of plan.completes) {
    const row = byId.get(action.sessionId);
    if (!row || row.ended_at === null) continue;
    const leased = await sb
      .from(SESSIONS_TABLE)
      .update({ ended_at: nowIso })
      .eq('id', row.id)
      .eq('status', 'abandoned')
      .is('became_ticket_id', null)
      .eq('ended_at', row.ended_at)
      .select('id');
    // Zero rows: another reader holds the lease, or the row was finished after
    // we read it. Either way it is not ours and not a failure.
    if (leased.error || !leased.data || leased.data.length === 0) continue;

    const done = await completeConversion(sb, request, authz, { ...row, ended_at: nowIso }, 'expired');
    if (done.ok) report.completed += 1;
    else report.failed += 1;
  }

  // 2. Kane's Q1. THE FLIP IS THE CLAIM: guarded on the session still being in
  //    an unanswered state, so two readers produce one ticket and one no-op.
  for (const action of plan.converts) {
    const row = byId.get(action.sessionId);
    if (!row) continue;
    const flipped = await sb
      .from(SESSIONS_TABLE)
      .update({ status: 'abandoned', ended_at: nowIso })
      .eq('id', row.id)
      // The compare. 'live' is absent on purpose — a conversation that started
      // is ended, not converted, and this is the backstop for that rule.
      .in('status', ['waiting', 'claimed'])
      // The condition that AUTHORISES the conversion, re-asserted at write
      // time. See `staleCutoff` above: without it, an employee who came back
      // between the plan and this flip gets converted while they watch.
      .lt('last_seen_at', staleCutoff)
      .select('id');
    if (flipped.error) {
      report.failed += 1;
      continue;
    }
    if (!flipped.data || flipped.data.length === 0) continue; // somebody else won it

    const done = await completeConversion(
      sb,
      request,
      authz,
      { ...row, status: 'abandoned', ended_at: nowIso },
      'expired',
    );
    if (done.ok) report.converted += 1;
    else report.failed += 1;
    announce(row.id, 'session');
  }

  // 3. A stale CLAIM goes back to the line at its ORIGINAL rank. Compare-and-set
  //    on the CURRENT holder; `queued_at` is untouched and the trigger would
  //    RAISE if it were (SQL :363-369).
  for (const action of plan.releases) {
    const released = await sb
      .from(SESSIONS_TABLE)
      .update({ status: 'waiting', claimed_by: null, claimed_at: null })
      .eq('id', action.sessionId)
      .eq('status', 'claimed')
      .eq('claimed_by', action.heldBy)
      .select('id');
    if (released.error || !released.data || released.data.length === 0) continue;
    report.released += 1;
    await systemLine(sb, action.sessionId, releasedSystemLine());
    announce(action.sessionId, 'session');
  }

  // 4. A conversation that simply stopped. 'ended', never 'abandoned': only an
  //    expiry with no answer earns an ES- number (Kane's Q1).
  for (const action of plan.ends) {
    const ended = await sb
      .from(SESSIONS_TABLE)
      .update({ status: 'ended', ended_at: nowIso })
      .eq('id', action.sessionId)
      .eq('status', 'live')
      // Same re-assertion as the conversion above, and it matters as much here:
      // ending a conversation the employee is still typing into is silent — no
      // ticket appears to make the mistake visible.
      .lt('last_seen_at', staleCutoff)
      .select('id');
    if (ended.error || !ended.data || ended.data.length === 0) continue;
    report.ended += 1;
    await systemLine(sb, action.sessionId, endedSystemLine());
    announce(action.sessionId, 'session');
  }

  if (report.failed > 0) {
    // A conversion that could not be finished is an employee owed a promise
    // nobody kept. It lands in `audit_log` rather than a console line for the
    // same reason `notify-failure-audit.ts` exists: a multi-week silence has to
    // outlive a log buffer. The likeliest cause by far is the 2026-09-16 ticket
    // migration not having run, whose live state is UNKNOWN, not unapplied.
    void insertAuditLog({
      ...auditFrom(request, authz),
      action: 'employee_support.chat.sweep_failed',
      resource: SESSIONS_TABLE,
      details: { ...report },
    });
  }

  return report;
}

