import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { deniedResponse, type AuthzOk } from '@/lib/auth/authorize-email';
import { requireFeatureAccessAnyView } from '@/lib/auth/authorize-feature';
import { auditFrom } from '@/lib/audit/context';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { classifyTableProbe } from '@/lib/db/probe-verdict';
import { normEmail } from '@/lib/email/norm-email';
import { broadcastFromServer } from '@/lib/supabase/realtime-broadcast';
import { recordNotifyFailure } from '@/lib/notifications/notify-failure-audit';
import { CHAT_LIVE_EVENT, CHAT_LIVE_TOPIC, type ChatLivePayload } from '@/lib/support/chat-live';
import { CHAT_OPEN_STATUSES, type ChatSessionStatus } from '@/lib/support/chat-types';
import { nextWaiter, sortQueue, type QueueRank } from '@/lib/support/queue';
import {
  agentsOnQueue,
  summarizeChatAvailability,
  type ChatAgentRow,
  type ChatAvailability,
} from '@/lib/support/availability';
import {
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

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Employee Support LIVE CHAT — the AGENT's side of the queue.
 *
 * Plan: docs/superpowers/plans/2026-09-19-employee-support-chat.md (tasks 11
 * and 14). Tables: references/sql/create/2026-09-19_employee_support_chat.sql.
 *
 *   GET   → { migrated, waiting, engaged, availability, me, sweep }
 *           the whole line in rank order, who is holding what, and who is on
 *           the queue. Running this read is ALSO what sweeps the queue (task
 *           14) — see THE SWEEP below.
 *   PATCH → { action: 'claim' }                take the next waiter
 *           { action: 'release', session_id }   hand a claim back to the line
 *           { action: 'end',     session_id }   close a conversation
 *
 * TWO GUARDED UPDATES, NEVER ONE LOOSENED ONE
 * ---------------------------------------------------------------------------
 * The plan's invariant (`:95-96`): **the claim is a compare-and-set on NULL;
 * the handoff is a compare-and-set on the CURRENT holder.** Both are written
 * the way `app/api/payment-dispatches/route.ts:230-249` writes a payment claim
 * — the condition lives in the UPDATE's own WHERE clause, and zero rows back is
 * a **409 whose copy states that nothing was recorded**, never a retry and
 * never a widened WHERE. Every read that precedes one of them is a
 * check-then-act, so its condition is repeated in the UPDATE
 * (`app/api/contractor/invoices/[id]/route.ts:118-145`).
 *
 * THE SWEEP (task 14, Kane's Q1) RUNS ON THIS READ AND NOWHERE ELSE YET
 * ---------------------------------------------------------------------------
 * `docs/features/INDEX.md:42` — *"Never add a cron"*: every `/api/cron/*` 401s
 * on the fail-closed `CRON_SECRET` gate and the two declared crons have never
 * once run. So an unanswered chat becomes an `ES-` ticket lazily, when somebody
 * reads the queue, exactly as `src/lib/bank-update/otp.ts:181` expires an OTP.
 *
 * The rules are in `src/lib/support/abandonment.ts` and are pure — the caller
 * below is deliberately thin, because `.env.local` holds only `.env.example`
 * placeholders (Kane: *"let us stay in local for now"*) and a rule that can only
 * be proved against production cannot be proved at all here.
 *
 * **KNOWN GAP, NAMED RATHER THAN HIDDEN:** this is the only route that sweeps.
 * The employee's own GET (`app/api/employee/support/chat/route.ts`) shipped
 * before task 14 existed and says so in its header, so an employee whose chat
 * expired learns their `ES-` number only once some agent opens the queue. The
 * fix is to lift {@link sweepChatQueue} into `src/lib/support/` and call it
 * from that route too; it is not done here because that file belongs to
 * another task and a Next.js route module cannot export a helper.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 * * **No auto-toggle onto the queue.** Claiming a chat does not declare an
 *   agent available. Q4 is *an explicit toggle, never presence*, and writing a
 *   declaration on somebody's behalf is the same mistake as inferring one.
 *   `app/api/support/chat/availability/route.ts` owns that column.
 * * **No claiming of a SPECIFIC session.** An agent takes the next waiter
 *   (plan `:30-31`). A queue where agents can cherry-pick is a queue where
 *   position stops meaning anything, and position is the one number the
 *   employee is shown.
 * * **No message bodies.** Those are the messages route's, and nothing here
 *   reads or returns one.
 */

const SESSIONS_TABLE = 'employee_support_chat_sessions';
const MESSAGES_TABLE = 'employee_support_chat_messages';
const AGENTS_TABLE = 'employee_support_chat_agents';
const TICKETS_TABLE = 'employee_support_tickets';

/** The feature key from the `employee_support` catalog (`feature-permissions.ts:121`). */
const SUPPORT_CHAT_FEATURE = 'support_chat';

/**
 * The three OPEN statuses, typed against the vocabulary module rather than
 * restated as bare strings — a status renamed there must not survive here as a
 * literal that silently matches nothing. Same constant the partial indexes are
 * scoped to (SQL `:198`, `:222`).
 */
const OPEN_STATUSES = [...CHAT_OPEN_STATUSES] as ChatSessionStatus[];

/**
 * The two statuses a claim can be released or ended FROM. Not `waiting` — there
 * is nothing to hand back — and not `ended`/`abandoned`, whose books are shut.
 */
const HELD_STATUSES = ['claimed', 'live'] as const satisfies readonly ChatSessionStatus[];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every column the sweep and the agent list need, read once and used by both.
 * `SweepSessionRow` is the shape `abandonment.ts` declares, so the select and
 * the pure module cannot drift apart without the compiler saying so.
 */
const SESSION_SELECT =
  'id, session_no, status, work_email, filed_by_email, member_name, department, queued_at, last_seen_at, ended_at, claimed_by, claimed_at, became_ticket_id';

type ChatSessionRow = SweepSessionRow & { claimed_at: string | null };

/** What the agent board renders. No message bodies, no `filed_by_email`. */
type QueueSessionWire = {
  id: string;
  session_no: number;
  status: ChatSessionStatus;
  work_email: string;
  member_name: string | null;
  department: string | null;
  queued_at: string;
  last_seen_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
};

const toWire = (row: ChatSessionRow): QueueSessionWire => ({
  id: row.id,
  session_no: row.session_no,
  status: row.status,
  work_email: row.work_email,
  member_name: row.member_name,
  department: row.department,
  queued_at: row.queued_at,
  last_seen_at: row.last_seen_at,
  claimed_by: row.claimed_by,
  claimed_at: row.claimed_at,
});

/** What one read's sweep actually did. Reported so a backlog is never silent. */
type SweepReport = {
  converted: number;
  completed: number;
  released: number;
  ended: number;
  /** Acts the caps pushed to the next read. The rows are still stale, not lost. */
  deferred: number;
  /** Conversions that could not be finished. Also written to `audit_log`. */
  failed: number;
};

const NO_SWEEP: SweepReport = { converted: 0, completed: 0, released: 0, ended: 0, deferred: 0, failed: 0 };

/** The FACT that a session moved. Never the content — see `chat-live.ts`. */
function announce(sessionId: string, kind: ChatLivePayload['kind']): void {
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
async function systemLine(sb: SupabaseClient, sessionId: string, body: string): Promise<void> {
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
async function readOpenSessions(
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
async function readUnstampedAbandoned(sb: SupabaseClient): Promise<ChatSessionRow[] | null> {
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
async function readAgents(sb: SupabaseClient): Promise<ChatAgentRow[] | null> {
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
async function readTranscript(
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
 * The stamp carries its own condition (`became_ticket_id IS NULL`) in its own
 * WHERE clause, so two callers racing produce one stamp and one no-op rather
 * than a last-writer-wins overwrite.
 */
async function completeConversion(
  sb: SupabaseClient,
  request: Request,
  authz: AuthzOk,
  session: ChatSessionRow,
): Promise<boolean> {
  const messages = await readTranscript(sb, session.id);
  // An unreadable transcript is not an empty one. Minting a ticket that claims
  // "the employee did not type anything" when in fact we could not read what
  // they typed would put a falsehood into the permanent record — and the next
  // read retries this for free.
  if (!messages) return false;

  let ticketId: string | null = null;
  let ticketNo: number | null = null;

  const existing = await sb
    .from(TICKETS_TABLE)
    .select('id, ticket_no')
    .eq('work_email', session.work_email)
    .ilike('concern', chatTicketConcernPattern(session.session_no))
    .order('created_at', { ascending: true })
    .limit(1);
  if (existing.error) return false;

  const found = (existing.data?.[0] as { id: string; ticket_no: number } | undefined) ?? null;
  if (found) {
    ticketId = found.id;
    ticketNo = found.ticket_no;
  } else {
    const minted = await sb
      .from(TICKETS_TABLE)
      .insert(buildChatTicket({ session, messages }))
      .select('id, ticket_no')
      .limit(1);
    if (minted.error) return false;
    const row = (minted.data?.[0] as { id: string; ticket_no: number } | undefined) ?? null;
    if (!row) return false;
    ticketId = row.id;
    ticketNo = row.ticket_no;
  }

  // The stamp. Both columns move as one act — `..._became_both_or_neither`
  // (SQL :155-156) — and the status is NOT re-asserted here: the CHECK
  // `..._only_abandoned_becomes_ticket` (:174-175) already refuses this write
  // on any other status, and a second copy of that rule in TypeScript is a
  // second thing to keep true.
  const stamped = await sb
    .from(SESSIONS_TABLE)
    .update({ became_ticket_id: ticketId, became_ticket_at: new Date().toISOString() })
    .eq('id', session.id)
    .is('became_ticket_id', null)
    .select('id');
  if (stamped.error) return false;
  // Zero rows: somebody else stamped it between our read and this write. The
  // ticket we may have just minted is theirs to have found; nothing is written
  // twice and nothing is told to the employee twice.
  if (!stamped.data || stamped.data.length === 0) return true;

  await systemLine(sb, session.id, becameTicketSystemLine(ticketNo));

  const { title, message } = becameTicketNotification({
    sessionNo: session.session_no,
    ticketNo,
  });
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
        origin: 'support/chat/queue sweep',
        error: notif.error,
        actor: { user_name: authz.sessionEmail, user_role: authz.roles[0] ?? 'user' },
        details: { session_no: session.session_no, ticket_no: ticketNo },
      });
    }
  }

  void insertAuditLog({
    ...auditFrom(request, authz),
    action: 'employee_support.chat.became_ticket',
    resource: SESSIONS_TABLE,
    resource_id: session.id,
    details: {
      session_no: session.session_no,
      ticket_no: ticketNo,
      work_email: session.work_email,
      // The sweep is nobody's decision — it is the passage of time. The actor
      // on the row is whoever's read happened to run it, which is the truth
      // about who touched the data and deliberately not a claim that they
      // chose to.
      swept_by_read: true,
    },
  });

  return true;
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
async function sweepChatQueue(
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

  // 1. Interrupted conversions first — that employee is already owed a number.
  for (const action of plan.completes) {
    const row = byId.get(action.sessionId);
    if (!row) continue;
    const ok = await completeConversion(sb, request, authz, row);
    if (ok) report.completed += 1;
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
      .select('id');
    if (flipped.error) {
      report.failed += 1;
      continue;
    }
    if (!flipped.data || flipped.data.length === 0) continue; // somebody else won it

    const ok = await completeConversion(sb, request, authz, { ...row, status: 'abandoned', ended_at: nowIso });
    if (ok) report.converted += 1;
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

/* ───────────────────────────────── gate ─────────────────────────────────── */

/**
 * Gate + client, at the level this verb needs.
 *
 * READS take `view`; every WRITE takes `edit`. This deliberately diverges from
 * `app/api/tickets/[id]/comments/route.ts:43-46`, which gates a reply at `view`
 * because "anyone who can see the board can reply" to a dev request. Speaking
 * and acting as Employee Support is not that: these rows carry pay disputes and
 * complaints naming a manager, and somebody deliberately granted `view` and not
 * `edit` on this catalog is somebody who was held back from answering them.
 * Nothing is loosened by the divergence — granting the `employee_support` role
 * auto-provisions `edit` (`provisionDashboardTabs`), so the five answerers are
 * unaffected and only a hand-limited grant is narrowed.
 */
async function prepare(
  level: 'view' | 'edit',
): Promise<{ ok: true; authz: AuthzOk; sb: SupabaseClient } | { ok: false; response: NextResponse }> {
  const authz = await requireFeatureAccessAnyView(SUPPORT_CHAT_FEATURE, level);
  if (!authz.ok) return { ok: false, response: deniedResponse(authz) };

  const sb = createSupabaseServiceRoleClient();
  if (!sb) {
    // No `migrated` here: nothing has asked the database anything, so nothing
    // may claim an answer about whether the migration ran.
    return {
      ok: false,
      response: NextResponse.json({ error: 'Support chat is unavailable right now.' }, { status: 503 }),
    };
  }
  return { ok: true, authz, sb };
}

/* ───────────────────────────────── GET ──────────────────────────────────── */

/**
 * GET — the line, who holds what, who is on the queue.
 *
 * `waiting` comes back in RANK order through `sortQueue`, the one comparator
 * (`queue.ts`), so the agent board and the employee's own position cannot be
 * derived from two different orderings. The set is read with `selectAllPaged`:
 * PostgREST caps a result set at 1000 rows with no error, and a truncated queue
 * is a confidently wrong board.
 */
export async function GET(request: Request) {
  const prepared = await prepare('view');
  if (!prepared.ok) return prepared.response;
  const { authz, sb } = prepared;

  const open = await readOpenSessions(sb);
  if (!open.migrated) {
    return NextResponse.json({
      migrated: false,
      waiting: [],
      engaged: [],
      availability: { state: 'unknown', onQueue: null, free: null } satisfies ChatAvailability,
      me: { email: authz.sessionEmail, on_queue: null, holding: null },
      sweep: null,
      error: null,
    });
  }
  if (open.error) {
    return NextResponse.json(
      {
        migrated: true,
        waiting: [],
        engaged: [],
        availability: { state: 'unknown', onQueue: null, free: null } satisfies ChatAvailability,
        me: { email: authz.sessionEmail, on_queue: null, holding: null },
        sweep: null,
        error: open.error,
      },
      { status: 500 },
    );
  }

  const agents = await readAgents(sb);

  // THE SWEEP, before the answer is built: a chat that expired must not be
  // rendered as still waiting on the same screen that just converted it.
  const sweep = await sweepChatQueue(sb, request, authz, { open: open.rows, agents });

  // Re-read only when the sweep actually moved something. A read that changed
  // nothing has nothing to re-read, and this route is polled.
  const settled =
    sweep.converted + sweep.released + sweep.ended > 0 ? await readOpenSessions(sb) : open;
  const rows = settled.migrated && !settled.error ? settled.rows : open.rows;

  const waiting = rows.filter((r) => r.status === 'waiting');
  const engaged = rows.filter((r) => r.status === 'claimed' || r.status === 'live');

  // One ordering, from the module that owns it. A board that re-derived its own
  // would disagree with the number the employee is looking at.
  const rankOrder = new Map(
    sortQueue(waiting.map((r): QueueRank => ({ id: r.id, queued_at: r.queued_at }))).map(
      (r, index) => [r.id, index] as const,
    ),
  );
  const waitingOrdered = [...waiting].sort(
    (a, b) => (rankOrder.get(a.id) ?? 0) - (rankOrder.get(b.id) ?? 0),
  );

  const me = normEmail(authz.sessionEmail);
  const myAgentRow = agents?.find((a) => normEmail(a.agent_email) === me) ?? null;

  return NextResponse.json({
    migrated: true,
    waiting: waitingOrdered.map(toWire),
    engaged: engaged.map(toWire),
    availability: summarizeChatAvailability({
      agents,
      engaged: engaged.map((r) => r.claimed_by),
      now: new Date(),
    }),
    me: {
      email: authz.sessionEmail,
      // `null` means we could not read the agents table — NOT "off the queue".
      on_queue: agents ? !!myAgentRow?.on_queue : null,
      holding: engaged.find((r) => normEmail(r.claimed_by) === me)?.id ?? null,
    },
    sweep,
    error: null,
  });
}

/* ──────────────────────────────── PATCH ─────────────────────────────────── */

type PatchBody = { action?: unknown; session_id?: unknown };

/** One sentence for a lost race, so the three branches cannot drift apart. */
const LOST_RACE = 'Somebody else got there first. Nothing was recorded — refresh the queue.';

export async function PATCH(request: Request) {
  const prepared = await prepare('edit');
  if (!prepared.ok) return prepared.response;
  const { authz, sb } = prepared;

  let body: PatchBody;
  try {
    body = ((await request.json()) as PatchBody) ?? {};
  } catch {
    return NextResponse.json({ session: null, error: 'Invalid request body' }, { status: 400 });
  }

  const action = typeof body.action === 'string' ? body.action : '';
  // The agent IS the session, never the body. Same rule as
  // `authz.effectiveEmail` writing the employee's row on the other side.
  const agent = normEmail(authz.sessionEmail);
  if (!agent) {
    return NextResponse.json({ session: null, error: 'Not signed in' }, { status: 401 });
  }

  if (action === 'claim') return claim(sb, request, authz, agent);
  if (action === 'release' || action === 'end') {
    const id = typeof body.session_id === 'string' ? body.session_id : '';
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ session: null, error: 'Chat not found.' }, { status: 404 });
    }
    return action === 'release'
      ? release(sb, request, authz, agent, id)
      : endChat(sb, request, authz, agent, id);
  }

  return NextResponse.json(
    { session: null, error: "Unknown action. Use 'claim', 'release' or 'end'." },
    { status: 400 },
  );
}

/**
 * CLAIM — take the next waiter.
 *
 * Three things in order, and the order is the design:
 *
 * 1. Read the line (paged) and pick the longest-waiting row through
 *    `nextWaiter`, the same comparator the employee's position comes from.
 * 2. Refuse if this agent already holds an open chat — *one agent holds one
 *    live chat at a time* (plan `:30-33`). This check is POLITE: there is no
 *    index behind it, so two tabs clicking together can both pass. The cost of
 *    losing that race is one agent holding two chats, which is a scheduling
 *    annoyance and not a corrupted row — named here rather than papered over.
 * 3. **The compare-and-set.** `WHERE status = 'waiting' AND claimed_by IS NULL`
 *    — zero rows back means somebody else took this waiter, and the answer is a
 *    409 saying nothing was recorded. The WHERE is never widened to make the
 *    retry succeed; the caller re-reads and claims the new next waiter.
 */
async function claim(sb: SupabaseClient, request: Request, authz: AuthzOk, agent: string) {
  const open = await readOpenSessions(sb);
  if (!open.migrated) {
    return NextResponse.json(
      { migrated: false, session: null, error: 'Live chat is not switched on yet. Nothing was changed.' },
      { status: 503 },
    );
  }
  if (open.error) {
    return NextResponse.json({ migrated: true, session: null, error: open.error }, { status: 500 });
  }

  const mine = open.rows.find(
    (r) => normEmail(r.claimed_by) === agent && (r.status === 'claimed' || r.status === 'live'),
  );
  if (mine) {
    return NextResponse.json(
      {
        migrated: true,
        session: toWire(mine),
        error: 'You are already in a chat. Finish it before taking the next one — nothing was changed.',
      },
      { status: 409 },
    );
  }

  const waiting = open.rows.filter((r) => r.status === 'waiting');
  const next = nextWaiter(waiting.map((r): QueueRank => ({ id: r.id, queued_at: r.queued_at })));
  if (!next) {
    return NextResponse.json(
      { migrated: true, session: null, error: 'Nobody is waiting right now.' },
      { status: 404 },
    );
  }

  const nowIso = new Date().toISOString();
  const { data, error } = await sb
    .from(SESSIONS_TABLE)
    .update({ status: 'claimed', claimed_by: agent, claimed_at: nowIso })
    .eq('id', next.id)
    // THE COMPARE. Both halves: the status AND the NULL holder. Either alone
    // would let a claim land on a row the other half had already moved.
    .eq('status', 'waiting')
    .is('claimed_by', null)
    .select(SESSION_SELECT);

  if (error) {
    if (classifyTableProbe(error) === 'MISSING') {
      return NextResponse.json(
        { migrated: false, session: null, error: 'Live chat is not switched on yet. Nothing was changed.' },
        { status: 503 },
      );
    }
    return NextResponse.json({ migrated: true, session: null, error: error.message }, { status: 500 });
  }

  const row = (data?.[0] as ChatSessionRow | undefined) ?? null;
  if (!row) {
    return NextResponse.json({ migrated: true, session: null, error: LOST_RACE }, { status: 409 });
  }

  // The employee learns who picked them up from the transcript, which is what
  // the `system` side exists for — a route does not hand out a staffer's
  // address to do it, and their NAME is not read here either: the agent's own
  // reply carries it (messages route), and a second lookup could disagree.
  await systemLine(sb, row.id, 'An agent has joined the chat.');

  void insertAuditLog({
    ...auditFrom(request, authz),
    action: 'employee_support.chat.claimed',
    resource: SESSIONS_TABLE,
    resource_id: row.id,
    details: { session_no: row.session_no, work_email: row.work_email },
  });

  announce(row.id, 'session');
  return NextResponse.json({ migrated: true, session: toWire(row), error: null });
}

/**
 * RELEASE — hand a claim back to the line.
 *
 * **The compare-and-set on the CURRENT holder**, which is the second half of
 * the plan's invariant (`:95-96`). `WHERE status = 'claimed' AND claimed_by =
 * <me>`: an agent cannot release somebody else's chat, and cannot release one
 * that has already moved on.
 *
 * Both claim columns are cleared in the one UPDATE —
 * `..._waiting_is_unclaimed` (SQL `:165-166`) rejects a waiting row that still
 * names an agent, so a release that forgot half would leave a waiter nobody can
 * take. `queued_at` is not named at all: a position never rises, and the
 * trigger RAISES on any attempt to move it.
 */
async function release(
  sb: SupabaseClient,
  request: Request,
  authz: AuthzOk,
  agent: string,
  sessionId: string,
) {
  const { data, error } = await sb
    .from(SESSIONS_TABLE)
    .update({ status: 'waiting', claimed_by: null, claimed_at: null })
    .eq('id', sessionId)
    .eq('status', 'claimed')
    .eq('claimed_by', agent)
    .select(SESSION_SELECT);

  if (error) {
    if (classifyTableProbe(error) === 'MISSING') {
      return NextResponse.json(
        { migrated: false, session: null, error: 'Live chat is not switched on yet. Nothing was changed.' },
        { status: 503 },
      );
    }
    return NextResponse.json({ migrated: true, session: null, error: error.message }, { status: 500 });
  }

  const row = (data?.[0] as ChatSessionRow | undefined) ?? null;
  if (!row) {
    // Deliberately one answer for "not yours", "already moved" and "does not
    // exist". A release is only ever attempted on a chat the agent can already
    // see, so nothing is being concealed — but three distinguishable answers
    // would be three ways to probe a session id.
    return NextResponse.json(
      {
        migrated: true,
        session: null,
        error: 'That chat is no longer yours to hand back. Nothing was changed — refresh the queue.',
      },
      { status: 409 },
    );
  }

  await systemLine(sb, row.id, releasedSystemLine());

  void insertAuditLog({
    ...auditFrom(request, authz),
    action: 'employee_support.chat.released',
    resource: SESSIONS_TABLE,
    resource_id: row.id,
    details: { session_no: row.session_no, work_email: row.work_email },
  });

  announce(row.id, 'session');
  return NextResponse.json({ migrated: true, session: toWire(row), error: null });
}

/**
 * END — close a conversation this agent is holding.
 *
 * 'ended', never 'abandoned'. Only an expiry with no answer earns an `ES-`
 * number (Kane's Q1), and a chat somebody actually worked has already been
 * answered — minting a ticket for it would promise the employee a second reply
 * that nobody owes them.
 *
 * Guarded on the current holder exactly as {@link release} is.
 */
async function endChat(
  sb: SupabaseClient,
  request: Request,
  authz: AuthzOk,
  agent: string,
  sessionId: string,
) {
  const { data, error } = await sb
    .from(SESSIONS_TABLE)
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('id', sessionId)
    .in('status', [...HELD_STATUSES])
    .eq('claimed_by', agent)
    .select(SESSION_SELECT);

  if (error) {
    if (classifyTableProbe(error) === 'MISSING') {
      return NextResponse.json(
        { migrated: false, session: null, error: 'Live chat is not switched on yet. Nothing was changed.' },
        { status: 503 },
      );
    }
    return NextResponse.json({ migrated: true, session: null, error: error.message }, { status: 500 });
  }

  const row = (data?.[0] as ChatSessionRow | undefined) ?? null;
  if (!row) {
    return NextResponse.json(
      {
        migrated: true,
        session: null,
        error: 'That chat is no longer yours to close. Nothing was changed — refresh the queue.',
      },
      { status: 409 },
    );
  }

  await systemLine(sb, row.id, 'The agent closed this chat.');

  void insertAuditLog({
    ...auditFrom(request, authz),
    action: 'employee_support.chat.ended',
    resource: SESSIONS_TABLE,
    resource_id: row.id,
    details: { session_no: row.session_no, work_email: row.work_email },
  });

  announce(row.id, 'session');
  return NextResponse.json({ migrated: true, session: toWire(row), error: null });
}
