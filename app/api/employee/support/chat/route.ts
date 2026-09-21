import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authorizeEmailAccess, deniedResponse, type AuthzOk } from '@/lib/auth/authorize-email';
import { auditFrom } from '@/lib/audit/context';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { classifyTableProbe } from '@/lib/db/probe-verdict';
import { getEmployeeMasterRecord } from '@/lib/supabase/employees';
import { normEmail } from '@/lib/email/norm-email';
import { broadcastFromServer } from '@/lib/supabase/realtime-broadcast';
import { CHAT_LIVE_EVENT, CHAT_LIVE_TOPIC, type ChatLivePayload } from '@/lib/support/chat-live';
import type { ChatSessionStatus } from '@/lib/support/chat-types';
import {
  QUEUE_UNRESOLVED,
  queuePositionFor,
  type QueueRank,
  type QueueState,
} from '@/lib/support/queue';
// Kane's Q1: the sweep runs on THIS read too, not only when an agent looks.
import { readAgents, readOpenSessions, sweepChatQueue } from '@/lib/support/chat-sweep';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Employee Support LIVE CHAT — the employee's own queue entry.
 *
 * Plan: docs/superpowers/plans/2026-09-19-employee-support-chat.md (task 9).
 * Table: references/sql/create/2026-09-19_employee_support_chat.sql.
 *
 *   GET    → { migrated, session, queue }  the caller's MOST RECENT session —
 *            open or finished, because an expired one carries the ES- number
 *            they are owed — and their place in the line. Branch on `status`.
 *            Also beats their heartbeat.
 *   POST   → enter the queue. One open session per employee: a second entry
 *            returns the FIRST one with `created: false`, never a new row.
 *   DELETE → leave the queue explicitly. Status 'ended', not 'abandoned'.
 *
 * WHY DELETE IS HERE WHEN TASK 9 NAMES ONLY GET AND POST
 * ---------------------------------------------------------------------------
 * The plan's signed invariant at `:88-90` reads "closing the modal does not
 * leave the queue … Leaving is an explicit action or an expiry", and this is
 * the only employee-side collection route in the task list, so the explicit
 * action has nowhere else to live.
 * Note which status it writes: 'ended' is "somebody closed it", 'abandoned' is
 * "it expired unanswered", and ONLY 'abandoned' becomes an ES- ticket — the
 * distinction is spelled out in the SQL header. An employee who withdraws has
 * withdrawn; they have not been failed by us, so they do not get a ticket.
 *
 * THE FOUR THINGS THIS FILE IS CAREFUL ABOUT
 * ---------------------------------------------------------------------------
 * 1. **`authz.effectiveEmail` writes the row, never the body's email.** The
 *    body carries at most a `email` REQUEST, which `authorizeEmailAccess`
 *    either grants (the caller is that person, or is elevated) or denies. The
 *    same shape as /api/resignation-requests and /api/time-adjustments.
 * 2. **A position is a COUNT over a set, and PostgREST caps a set at 1000 rows
 *    with no error.** The queue is read through `selectAllPaged`. An unpaged
 *    read yields a confidently wrong position, which is worse than none.
 * 3. **"Nobody is waiting" and "we cannot tell" are different states.** The
 *    queue block carries `resolved`; false means the UI shows a skeleton and
 *    never `0`, never "you're next".
 * 4. **A missing migration answers cleanly.** `migrated: false` on a read,
 *    503 on a write — never a 500, and never a silent pretend-save. The chat
 *    SQL is pending Kane's `--apply` and this code can deploy before it runs.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 * * **No status transition to 'claimed' or 'live'.** Those are the agent
 *   side's compare-and-set (plan tasks 11-12). An employee route that also
 *   moved the status would be a second writer racing the first.
 * * ~~**No expiry sweep.**~~ **CHANGED 2026-09-21 — this GET now sweeps.** Task
 *   14's conversion lived only on the agent queue GET, so Kane's Q1 promise
 *   fired only while an agent was looking, which is never true of the chats
 *   that go unanswered. The rules moved to `src/lib/support/chat-sweep.ts` and
 *   this read calls them too — an employee checking their own place is the read
 *   that always happens. It runs BEFORE the state read, so a response that says
 *   "this expired" already carries the ES- number, and it can never fail the
 *   request.
 * * **No `claimed_by` in the wire shape.** The employee learns who picked
 *   their chat up from the 'system' line in the transcript ("Carla joined"),
 *   which is what that author side exists for. A route does not need to hand
 *   out a staffer's address to do that.
 */

const SESSIONS_TABLE = 'employee_support_chat_sessions';
const MESSAGES_TABLE = 'employee_support_chat_messages';
const TICKETS_TABLE = 'employee_support_tickets';

/**
 * The three OPEN statuses — the same set the partial unique index and the
 * staleness index are scoped to. Typed against the vocabulary module rather
 * than restated as bare strings, so a status that is renamed there cannot
 * survive here as a literal that silently matches nothing.
 */
const OPEN_STATUSES = ['waiting', 'claimed', 'live'] as const satisfies readonly ChatSessionStatus[];

/** PostgREST surfaces a unique violation as `23505` — the one-open-session index firing. */
const UNIQUE_VIOLATION = '23505';

const SESSION_SELECT =
  'id, session_no, status, queued_at, claimed_at, ended_at, last_seen_at, became_ticket_id, became_ticket_at, created_at';

type ChatSessionRow = {
  id: string;
  session_no: number;
  status: ChatSessionStatus;
  queued_at: string;
  claimed_at: string | null;
  ended_at: string | null;
  last_seen_at: string;
  became_ticket_id: string | null;
  became_ticket_at: string | null;
  created_at: string;
};

/**
 * `QueueRank`, `QueueState`, `QUEUE_UNRESOLVED`, `QUEUE_READ_FAILED` and
 * `queuePositionFor` come from `@/lib/support/queue`.
 *
 * They were declared here until 2026-09-21, and the duplication was not
 * harmless: this copy is the one the employee actually saw, so the module's
 * tests — including its 1000-row boundary proof — covered a function nothing
 * called. The local copy also trusted whatever order the caller handed it
 * instead of re-sorting, had no guard for an unparseable stamp, and exposed an
 * UNFROZEN shared singleton straight into `NextResponse.json`.
 *
 * The wire shape is unchanged: field-for-field identical plus an optional
 * `reason`, which the client ignores.
 */

/** The employee-facing projection. No `claimed_by`, no flags — see the header. */
type ChatSessionWire = ChatSessionRow & {
  /** The ES- number this chat became, when an expiry converted it. Null otherwise. */
  became_ticket_no: number | null;
};

/**
 * Who the caller is, resolved SERVER-SIDE from the master list.
 *
 * `work_email` is the canonical key every other surface joins on and the one
 * the "one open session per employee" unique index is built over, so GET, POST
 * and DELETE must all resolve it the same way or they will disagree about
 * whether a session exists.
 */
type ChatIdentity = {
  work_email: string;
  member_name: string | null;
  department: string | null;
};

/**
 * Resolve identity, or refuse.
 *
 * A master-list READ FAILURE is not the same as an employee with no master row.
 * The second is legitimate (internal devs and founders fall off the sheet) and
 * falls back to the signed-in address. The first would silently key the session
 * on the WRONG email — the GET would then report "no chat open" while one
 * exists, the employee would enter again, and the unique index would reject an
 * entry this route could no longer find. So a read failure stops the request
 * instead of guessing.
 */
async function resolveIdentity(
  effectiveEmail: string,
): Promise<{ identity: ChatIdentity | null; error: string | null }> {
  const { employee, error } = await getEmployeeMasterRecord(effectiveEmail);
  if (error) return { identity: null, error };
  return {
    identity: {
      work_email: normEmail(employee?.work_email) ?? effectiveEmail,
      member_name: employee?.name?.trim() || null,
      // RAW master-list Department key ('hsl:intake_specialist'), never a label.
      department: employee?.department?.trim() || null,
    },
    error: null,
  };
}

/**
 * The caller's open session, or null.
 *
 * `.limit(1)` rather than `.maybeSingle()` on purpose: the partial unique index
 * guarantees at most one open session, but `maybeSingle()` THROWS when a second
 * row exists, so an environment where that index failed to apply would turn a
 * data problem into a 500 on every poll. Ordered newest-rank-first so the one
 * row it does return is deterministic either way.
 *
 * Matching on `work_email` rather than `lower(work_email)` is safe because the
 * normalising trigger lowercases the column on write; the expression index is
 * the uniqueness backstop, not the lookup path.
 */
async function readOpenSession(
  sb: SupabaseClient,
  workEmail: string,
): Promise<{ row: ChatSessionRow | null; error: string | null; migrated: boolean }> {
  const { data, error } = await sb
    .from(SESSIONS_TABLE)
    .select(SESSION_SELECT)
    .eq('work_email', workEmail)
    .in('status', [...OPEN_STATUSES])
    .order('queued_at', { ascending: false })
    .limit(1);
  if (error) {
    if (classifyTableProbe(error) === 'MISSING') return { row: null, error: null, migrated: false };
    return { row: null, error: error.message, migrated: true };
  }
  return { row: ((data?.[0] as ChatSessionRow | undefined) ?? null), error: null, migrated: true };
}

/**
 * The caller's MOST RECENT session, whatever its status — what GET answers with.
 *
 * Deliberately NOT status-filtered, and this is the whole Q1 loop closing on the
 * employee side: an expired chat leaves the open statuses the instant the sweep
 * flips it to 'abandoned', so a read scoped to open sessions would hand the
 * employee `null` and they would never learn the ES- number their question
 * turned into. The one thing the feature promises them would arrive nowhere.
 *
 * So the truth is returned and `status` is the field the client branches on.
 * The WRITE paths keep using {@link readOpenSession}: a chat that ended last
 * month must not block a new one, and that is exactly what the partial unique
 * index encodes.
 */
async function readLatestSession(
  sb: SupabaseClient,
  workEmail: string,
): Promise<{ row: ChatSessionRow | null; error: string | null; migrated: boolean }> {
  const { data, error } = await sb
    .from(SESSIONS_TABLE)
    .select(SESSION_SELECT)
    .eq('work_email', workEmail)
    .order('queued_at', { ascending: false })
    .limit(1);
  if (error) {
    if (classifyTableProbe(error) === 'MISSING') return { row: null, error: null, migrated: false };
    return { row: null, error: error.message, migrated: true };
  }
  return { row: ((data?.[0] as ChatSessionRow | undefined) ?? null), error: null, migrated: true };
}

/**
 * THE QUEUE. Every waiting session, in rank order, through `selectAllPaged`.
 *
 * There is no `position` column and there must not be one: a stored position is
 * wrong the moment anybody ahead leaves the line. The rank is `queued_at`, tied
 * rows break on `id` so two pages of the same set cannot shear into a different
 * order between reads.
 */
async function readQueue(sb: SupabaseClient): Promise<QueueRank[] | null> {
  const { rows, error } = await selectAllPaged<QueueRank>((from, to) =>
    sb
      .from(SESSIONS_TABLE)
      .select('id, queued_at')
      .eq('status', 'waiting')
      .order('queued_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  // `null` is the ONE failure answer this read has, and it means "we cannot
  // tell". It deliberately does not distinguish a missing table from a broken
  // read: the caller has already established the table exists by reading the
  // caller's own session out of it, and a position we could not compute is the
  // same state either way — a skeleton, never a `0`.
  return error ? null : rows;
}

// Ranking lives in `queuePositionFor` (src/lib/support/queue.ts). It handles
// every case this function used to: an unread line, a caller who is not
// waiting, and the claimed-between-the-two-reads race where the session says
// 'waiting' but is absent from the set — reported as unknown rather than
// invented, with `reason: 'not_in_set'`.

/**
 * The ES- number an expired chat turned into (Q1).
 *
 * Best-effort by design: the ticket tables ship in a SEPARATE migration whose
 * live state is unknown, and a chat session is still a true, readable thing
 * when its ticket number cannot be resolved. Never fails the request.
 */
async function ticketNoFor(sb: SupabaseClient, ticketId: string | null): Promise<number | null> {
  if (!ticketId) return null;
  const { data, error } = await sb
    .from(TICKETS_TABLE)
    .select('ticket_no')
    .eq('id', ticketId)
    .limit(1);
  if (error) return null;
  return (data?.[0] as { ticket_no?: number } | undefined)?.ticket_no ?? null;
}

/**
 * The EMPLOYEE's heartbeat.
 *
 * `last_seen_at` is how a closed browser leaves the queue: nothing sweeps it,
 * and staleness is compared to `now()` on read (the chat SQL header, and the
 * `INDEX.md:42` "never add a cron" rule behind it). Scoped to the open statuses
 * so a beat can never freshen a session that has already ended, and it never
 * touches `queued_at` — the trigger RAISES on an attempt to move a rank.
 *
 * Fire-and-forget: a lost beat costs one staleness window, and a failed beat
 * must not fail the read the employee is actually waiting on.
 */
async function beat(sb: SupabaseClient, sessionId: string): Promise<void> {
  try {
    // supabase-js RETURNS a PostgREST error rather than throwing one, so the
    // `{ error }` is discarded here on purpose and the catch is for a transport
    // failure. Both are ignored, and both are ignored knowingly.
    await sb
      .from(SESSIONS_TABLE)
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', sessionId)
      .in('status', [...OPEN_STATUSES]);
  } catch {
    /* see above */
  }
}

/**
 * Announce that a session moved. THE FACT, NEVER THE CONTENT.
 *
 * No message body and no email crosses this topic. The browser client is anon
 * and there is no `private: true` channel anywhere in this repo, so every
 * anon-key holder who subscribes to the topic string receives everything sent
 * on it — which is exactly the defect the plan names in `CobrowseChatProvider`.
 * A session id is a uuid and tells a listener nothing; every client re-fetches
 * through its own gated route.
 */
function announce(sessionId: string, kind: ChatLivePayload['kind']): void {
  // Spread into a fresh object literal: `broadcastFromServer` takes a
  // `Record<string, unknown>` and a declared interface carries no index
  // signature to satisfy it. The `satisfies` is what keeps the payload checked
  // against the contract instead of the cast this would otherwise become.
  void broadcastFromServer(CHAT_LIVE_TOPIC, CHAT_LIVE_EVENT, {
    ...({ kind, sessionId, ts: Date.now() } satisfies ChatLivePayload),
  });
}

function toWire(row: ChatSessionRow, becameTicketNo: number | null): ChatSessionWire {
  return { ...row, became_ticket_no: becameTicketNo };
}

/** Everything a caller needs before touching the tables: a gate, a client, an identity. */
async function prepare(
  requestedEmail: string | null,
): Promise<
  | { ok: true; authz: AuthzOk; sb: SupabaseClient; identity: ChatIdentity }
  | { ok: false; response: NextResponse }
> {
  const authz = await authorizeEmailAccess(requestedEmail);
  if (!authz.ok) return { ok: false, response: deniedResponse(authz) };

  // NOTE WHAT IS ABSENT FROM THESE TWO BODIES: `migrated`. Neither failure has
  // asked the database anything, so neither knows whether the migration ran,
  // and answering `migrated: false` would be a claim this code cannot support —
  // the UI would tell the employee chat is not set up when the truth is that we
  // could not look. `migrated` appears only where it was actually established.
  const sb = createSupabaseServiceRoleClient();
  if (!sb) {
    return {
      ok: false,
      response: NextResponse.json(
        { session: null, queue: QUEUE_UNRESOLVED, error: 'Chat is unavailable right now.' },
        { status: 503 },
      ),
    };
  }

  const { identity, error } = await resolveIdentity(authz.effectiveEmail);
  if (!identity) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          session: null,
          queue: QUEUE_UNRESOLVED,
          error: error ?? 'We could not confirm who you are just now. Try again in a moment.',
        },
        { status: 503 },
      ),
    };
  }
  return { ok: true, authz, sb, identity };
}

/** The caller's most recent session + the line, in the shape GET answers with. */
async function readState(
  sb: SupabaseClient,
  identity: ChatIdentity,
): Promise<
  | { ok: true; row: ChatSessionRow | null; queue: QueueState; ticketNo: number | null }
  | { ok: false; response: NextResponse }
> {
  const session = await readLatestSession(sb, identity.work_email);
  if (!session.migrated) {
    return {
      ok: false,
      response: NextResponse.json({
        migrated: false,
        session: null,
        queue: QUEUE_UNRESOLVED,
        error: null,
      }),
    };
  }
  if (session.error) {
    return {
      ok: false,
      response: NextResponse.json(
        { migrated: true, session: null, queue: QUEUE_UNRESOLVED, error: session.error },
        { status: 500 },
      ),
    };
  }

  const waiting = await readQueue(sb);
  const ticketNo = await ticketNoFor(sb, session.row?.became_ticket_id ?? null);
  return { ok: true, row: session.row, queue: queuePositionFor(waiting, session.row), ticketNo };
}

/**
 * GET — the caller's own latest chat and their place in the line.
 *
 * This is the employee's poll, so it is also their heartbeat (a no-op on a
 * session that has already finished — `beat` is scoped to the open statuses).
 * `?email=` is a REQUEST that `authorizeEmailAccess` grants only to the person
 * themself or to an elevated viewer.
 *
 * `session` may be an ENDED or ABANDONED row: see {@link readLatestSession}.
 * `queue.position` is null for those, with `resolved: true` — they are not in
 * the line, which is a different thing from us not knowing.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const prepared = await prepare(searchParams.get('email'));
  if (!prepared.ok) return prepared.response;
  const { authz, sb, identity } = prepared;

  // THE SWEEP RUNS HERE TOO, AND THIS IS THE READ THAT MATTERS (Kane's Q1).
  //
  // Until 2026-09-21 the agent queue GET was its only caller, which meant the
  // promise — an unanswered chat becomes an ES- ticket — fired only when an
  // agent happened to open /tickets. The chats that go unanswered are exactly
  // the ones nobody is watching, so an employee could wait, go quiet, and learn
  // nothing until somebody opened the board on Monday. An employee checking
  // their own place is the read that always happens, so it is the read that has
  // to convert. There is no cron and there must not be one
  // (docs/features/INDEX.md:42).
  //
  // BEFORE readState, deliberately: the sweep may convert THIS caller's own
  // session, and running it first means the very response that tells them the
  // chat expired already carries the ticket number it became.
  //
  // It can never break the read. A failed sweep leaves the rows stale and the
  // next read retries for free; an employee asking where they are in the line
  // must not get a 500 because a conversion three rows away failed.
  try {
    const open = await readOpenSessions(sb);
    if (open.migrated && !open.error) {
      await sweepChatQueue(sb, request, authz, { open: open.rows, agents: await readAgents(sb) });
    }
  } catch {
    /* see above */
  }

  const state = await readState(sb, identity);
  if (!state.ok) return state.response;

  if (state.row) void beat(sb, state.row.id);

  return NextResponse.json({
    migrated: true,
    session: state.row ? toWire(state.row, state.ticketNo) : null,
    queue: state.queue,
    error: null,
  });
}

/**
 * POST — enter the queue.
 *
 * ONE OPEN SESSION PER EMPLOYEE. The check here is polite; the partial unique
 * index on `lower(work_email)` over the three open statuses is what makes it
 * TRUE, because a check-then-insert in application code is a race and an index
 * is not. A second entry returns the FIRST session with `created: false` — the
 * employee keeps the place they already hold, which is the same rule as "a
 * position never rises", stated from the other end.
 *
 * Note what is NOT written: `status` and `queued_at`. Their column defaults own
 * them, so this route cannot start somebody at the wrong rank even by accident.
 */
export async function POST(request: Request) {
  let body: { email?: string | null } = {};
  try {
    // An empty body is the normal case — entering your own queue needs no
    // arguments at all. Only an elevated viewer sends anything.
    body = ((await request.json()) as { email?: string | null }) ?? {};
  } catch {
    body = {};
  }

  const prepared = await prepare(body?.email ?? null);
  if (!prepared.ok) return prepared.response;
  const { authz, sb, identity } = prepared;

  const existing = await readOpenSession(sb, identity.work_email);
  if (!existing.migrated) {
    return NextResponse.json(
      {
        migrated: false,
        session: null,
        queue: QUEUE_UNRESOLVED,
        created: false,
        error: 'Live chat is not switched on yet. Nothing was saved — please use Employee Support instead.',
      },
      { status: 503 },
    );
  }
  if (existing.error) {
    return NextResponse.json(
      { migrated: true, session: null, queue: QUEUE_UNRESOLVED, created: false, error: existing.error },
      { status: 500 },
    );
  }

  if (existing.row) {
    void beat(sb, existing.row.id);
    const waiting = await readQueue(sb);
    const ticketNo = await ticketNoFor(sb, existing.row.became_ticket_id);
    return NextResponse.json({
      migrated: true,
      session: toWire(existing.row, ticketNo),
      queue: queuePositionFor(waiting, existing.row),
      created: false,
      error: null,
    });
  }

  const { data, error } = await sb
    .from(SESSIONS_TABLE)
    .insert({
      // The session is the answer; the body was only ever a request.
      work_email: identity.work_email,
      // The address that actually carried this request — which is the column's
      // stated purpose, and legitimately a personal or alternate address. It
      // also differs from `work_email` when an elevated viewer opened the chat
      // from somebody's dashboard, and that is exactly the fact worth keeping.
      filed_by_email: authz.sessionEmail,
      member_name: identity.member_name,
      department: identity.department,
    })
    .select(SESSION_SELECT)
    .limit(1);

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      // Two tabs submitted at once and the index did its job. Return the row
      // that won — the employee has one place in the line, not an error.
      const again = await readOpenSession(sb, identity.work_email);
      if (again.row) {
        const waiting = await readQueue(sb);
        return NextResponse.json({
          migrated: true,
          session: toWire(again.row, await ticketNoFor(sb, again.row.became_ticket_id)),
          queue: queuePositionFor(waiting, again.row),
          created: false,
          error: null,
        });
      }
      return NextResponse.json(
        {
          migrated: true,
          session: null,
          queue: QUEUE_UNRESOLVED,
          created: false,
          error: 'You are already in the queue. Refresh to see your place — nothing was added.',
        },
        { status: 409 },
      );
    }
    if (classifyTableProbe(error) === 'MISSING') {
      return NextResponse.json(
        {
          migrated: false,
          session: null,
          queue: QUEUE_UNRESOLVED,
          created: false,
          error: 'Live chat is not switched on yet. Nothing was saved — please use Employee Support instead.',
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { migrated: true, session: null, queue: QUEUE_UNRESOLVED, created: false, error: error.message },
      { status: 500 },
    );
  }

  const row = (data?.[0] as ChatSessionRow | undefined) ?? null;
  if (!row) {
    return NextResponse.json(
      {
        migrated: true,
        session: null,
        queue: QUEUE_UNRESOLVED,
        created: false,
        error: 'The chat was not created. Nothing was saved — please try again.',
      },
      { status: 500 },
    );
  }

  void insertAuditLog({
    ...auditFrom(request, authz),
    action: 'employee_support.chat.entered',
    resource: SESSIONS_TABLE,
    resource_id: row.id,
    details: {
      session_no: row.session_no,
      work_email: identity.work_email,
      // True ONLY when an elevated viewer acted for somebody else. Compared
      // against effectiveEmail, never work_email: an employee who signs in with
      // a personal address has a session email that differs from their master
      // work email, and flagging that as acting-on-behalf would be a lie.
      on_behalf: authz.sessionEmail !== authz.effectiveEmail,
    },
  });

  announce(row.id, 'session');

  const waiting = await readQueue(sb);
  return NextResponse.json({
    migrated: true,
    session: toWire(row, null),
    queue: queuePositionFor(waiting, row),
    created: true,
    error: null,
  });
}

/**
 * DELETE — leave the queue, deliberately.
 *
 * 'ended', never 'abandoned': only an expiry becomes an ES- ticket (Q1), and
 * somebody who withdraws has not been failed by us. The claim columns are left
 * as they stand — who was with them is history, and history is not cleaned up.
 *
 * The UPDATE is scoped to the caller's own open session, so there is no id to
 * pass and none to guess. Zero rows back is a 404, not a 500: it means there
 * was nothing to leave.
 */
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const prepared = await prepare(searchParams.get('email'));
  if (!prepared.ok) return prepared.response;
  const { authz, sb, identity } = prepared;

  const nowIso = new Date().toISOString();
  const { data, error } = await sb
    .from(SESSIONS_TABLE)
    .update({ status: 'ended', ended_at: nowIso })
    .eq('work_email', identity.work_email)
    .in('status', [...OPEN_STATUSES])
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
      { migrated: true, session: null, error: 'You have no chat open.' },
      { status: 404 },
    );
  }

  // A 'system' line, so the transcript says what happened. It is written by
  // nobody — author_email is NULL, which the side CHECK requires — because
  // attributing "the employee left" to the employee puts words in their mouth
  // inside a record that may become a ticket.
  //
  // Best-effort, and knowingly so: the leave is already committed above, a
  // returned PostgREST error is discarded and the catch covers a transport
  // failure. A transcript missing its closing line is a smaller wrong than a
  // leave that reports failure after it happened.
  try {
    await sb.from(MESSAGES_TABLE).insert({
      session_id: row.id,
      author_side: 'system',
      author_email: null,
      author_name: null,
      body: 'The employee left the chat.',
    });
  } catch {
    /* the transcript loses a line; the employee still left */
  }

  void insertAuditLog({
    ...auditFrom(request, authz),
    action: 'employee_support.chat.left',
    resource: SESSIONS_TABLE,
    resource_id: row.id,
    details: {
      session_no: row.session_no,
      work_email: identity.work_email,
      on_behalf: authz.sessionEmail !== authz.effectiveEmail,
    },
  });

  announce(row.id, 'session');

  return NextResponse.json({ migrated: true, session: toWire(row, null), error: null });
}
