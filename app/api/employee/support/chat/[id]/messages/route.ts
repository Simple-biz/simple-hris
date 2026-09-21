import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authorizeEmailAccess, deniedResponse, type AuthzOk } from '@/lib/auth/authorize-email';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { classifyTableProbe } from '@/lib/db/probe-verdict';
import { getEmployeeMasterRecord } from '@/lib/supabase/employees';
import { normEmail } from '@/lib/email/norm-email';
import { broadcastFromServer } from '@/lib/supabase/realtime-broadcast';
import { screenText } from '@/lib/support/screening';
import { SUPPORT_CONCERN_MAX } from '@/lib/support/types';
import { CHAT_LIVE_EVENT, CHAT_LIVE_TOPIC, type ChatLivePayload } from '@/lib/support/chat-live';
import type { ChatSessionStatus } from '@/lib/support/chat-types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Employee Support LIVE CHAT — the transcript of ONE of the caller's own chats.
 *
 * Plan: docs/superpowers/plans/2026-09-19-employee-support-chat.md (task 10).
 * Table: references/sql/create/2026-09-19_employee_support_chat.sql.
 *
 *   GET  → { migrated, session, messages }  the whole thread, oldest first.
 *   POST → { body } one employee message. Screened, never blocked.
 *
 * 404, NOT 403, ON SOMEBODY ELSE'S ID
 * ---------------------------------------------------------------------------
 * A 403 is an answer: it confirms the id names a real chat. Every rejection
 * here — a malformed id, an id that does not exist, an id belonging to another
 * employee — returns the same 404 with the same sentence, so the response says
 * nothing about which of the three happened. The ownership test is deliberately
 * the LAST thing that runs, for the same reason. Same rule as
 * /api/employee/documents/[id].
 *
 * A FLAG NEVER BLOCKS, AND THE EMPLOYEE NEVER SEES IT
 * ---------------------------------------------------------------------------
 * `screenText` runs on every employee message and records what it saw; the
 * message is delivered either way. That is the shipped design and its reasons
 * are in `src/lib/support/screening.ts` — a blocking screen silences the person
 * with a real complaint, on the one channel built for complaints, and in a chat
 * it would do it mid-sentence.
 *
 * The flag is a note to the STAFFER who reads the thread, so `flagged_at` and
 * `flag_reason` are not selected into the employee projection at all. Handing
 * somebody "this contains strong language" about their own message turns a
 * reading aid into an accusation.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 * * **No status transition.** An employee message does not move a session from
 *   'claimed' to 'live'; that is the agent side's compare-and-set (plan task
 *   12), and a second writer racing it would be the bug this design avoids.
 * * **No edit and no delete.** The message table has no `updated_at` and no
 *   edit path: this transcript IS the content of the ticket an abandoned chat
 *   becomes, and an editable record answers a different question.
 * * **No `author_email` in the response.** An agent's name reaches the employee
 *   through `author_name`; their address is not the employee's to have.
 * * **No audit row per message.** The transcript is already the permanent
 *   record, and one `audit_log` row per typed line is noise that buries the
 *   lifecycle events the collection route does write.
 */

const SESSIONS_TABLE = 'employee_support_chat_sessions';
const MESSAGES_TABLE = 'employee_support_chat_messages';

/** The three OPEN statuses — typed against the vocabulary, never bare strings. */
const OPEN_STATUSES = ['waiting', 'claimed', 'live'] as const satisfies readonly ChatSessionStatus[];

/**
 * One sentence for every "this is not your chat" outcome. A constant, so the
 * three branches cannot drift into three distinguishable answers — which is how
 * a 404 quietly turns back into a 403.
 */
const NOT_FOUND = 'Chat not found.';

/** Postgres `uuid` literals only, so a malformed id is a 404 here and not a 22P02 from PostgREST. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SESSION_SELECT = 'id, session_no, status, work_email, member_name';
const MESSAGE_SELECT = 'id, author_side, author_name, body, created_at';

type ChatSessionRow = {
  id: string;
  session_no: number;
  status: ChatSessionStatus;
  work_email: string;
  member_name: string | null;
};

/** What the employee is handed back. No author_email, no flag columns. */
type ChatMessageRow = {
  id: string;
  author_side: 'employee' | 'agent' | 'system';
  author_name: string | null;
  body: string;
  created_at: string;
};

/**
 * Why a session lookup failed, as a VALUE rather than a pre-rendered response.
 *
 * GET and POST owe different answers to the same failure — a missing migration
 * is a readable "nothing here yet" for a reader and a 503 "nothing was sent"
 * for a writer — so the lookup reports what happened and each verb decides the
 * status and the shape. A helper that returned a finished `NextResponse` would
 * have had to pick one, and the loser would answer 200 to a write that did not
 * happen.
 */
type SessionLookupFailure =
  | { reason: 'not_found' }
  | { reason: 'not_migrated' }
  | { reason: 'error'; message: string };

/**
 * Gate, client, and the caller's canonical work email.
 *
 * `work_email` is resolved from the master list exactly as the collection route
 * resolves it, because the two routes must agree about who owns a session. A
 * master-list READ FAILURE stops the request rather than falling back to the
 * signed-in address: a wrong key here would 404 an employee out of their own
 * live conversation.
 *
 * Neither failure body carries `migrated` — see the collection route's note.
 * Nothing here has asked the database whether the migration ran, so nothing
 * here may claim an answer.
 */
async function prepare(
  requestedEmail: string | null,
): Promise<
  | { ok: true; authz: AuthzOk; sb: SupabaseClient; workEmail: string }
  | { ok: false; response: NextResponse }
> {
  const authz = await authorizeEmailAccess(requestedEmail);
  if (!authz.ok) return { ok: false, response: deniedResponse(authz) };

  const sb = createSupabaseServiceRoleClient();
  if (!sb) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Chat is unavailable right now.' }, { status: 503 }),
    };
  }

  const { employee, error } = await getEmployeeMasterRecord(authz.effectiveEmail);
  if (error) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: error ?? 'We could not confirm who you are just now. Try again in a moment.' },
        { status: 503 },
      ),
    };
  }

  return { ok: true, authz, sb, workEmail: normEmail(employee?.work_email) ?? authz.effectiveEmail };
}

/** The session at `id`, but ONLY if it belongs to the caller. */
async function readOwnSession(
  sb: SupabaseClient,
  id: string,
  workEmail: string,
): Promise<{ ok: true; row: ChatSessionRow } | ({ ok: false } & SessionLookupFailure)> {
  if (!UUID_RE.test(id)) return { ok: false, reason: 'not_found' };

  const { data, error } = await sb.from(SESSIONS_TABLE).select(SESSION_SELECT).eq('id', id).limit(1);
  if (error) {
    if (classifyTableProbe(error) === 'MISSING') return { ok: false, reason: 'not_migrated' };
    return { ok: false, reason: 'error', message: error.message };
  }

  const row = (data?.[0] as ChatSessionRow | undefined) ?? null;
  // Existence and ownership collapse into the same answer, on purpose.
  if (!row || row.work_email !== workEmail) return { ok: false, reason: 'not_found' };
  return { ok: true, row };
}

/** The employee's heartbeat. Open sessions only; never touches `queued_at`. */
async function beat(sb: SupabaseClient, sessionId: string): Promise<void> {
  try {
    // supabase-js RETURNS a PostgREST error rather than throwing one, so the
    // `{ error }` is discarded on purpose and the catch is for a transport
    // failure. A lost beat costs one staleness window and must not fail the
    // read the employee is actually waiting on.
    await sb
      .from(SESSIONS_TABLE)
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', sessionId)
      .in('status', [...OPEN_STATUSES]);
  } catch {
    /* see above */
  }
}

/** The FACT that this thread moved. No body, no email — see the collection route's header. */
function announce(sessionId: string, kind: ChatLivePayload['kind']): void {
  // A declared interface has no index signature, so the literal is spread fresh
  // into the `Record<string, unknown>` the broadcaster takes; `satisfies` is
  // what keeps it checked against the contract rather than cast past it.
  void broadcastFromServer(CHAT_LIVE_TOPIC, CHAT_LIVE_EVENT, {
    ...({ kind, sessionId, ts: Date.now() } satisfies ChatLivePayload),
  });
}

/** The thread, oldest first. A transcript is a SET, so it pages. */
async function readThread(
  sb: SupabaseClient,
  sessionId: string,
): Promise<{ rows: ChatMessageRow[]; error: string | null; migrated: boolean }> {
  const { rows, error } = await selectAllPaged<ChatMessageRow>((from, to) =>
    sb
      .from(MESSAGES_TABLE)
      .select(MESSAGE_SELECT)
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (error) {
    // The two chat tables ship in one file, so a present sessions table with an
    // absent messages table means a half-applied migration — still "not
    // migrated", never an empty transcript presented as the truth.
    if (classifyTableProbe({ message: error }) === 'MISSING') {
      return { rows: [], error: null, migrated: false };
    }
    return { rows: [], error, migrated: true };
  }
  return { rows, error: null, migrated: true };
}

const sessionWire = (row: ChatSessionRow) => ({
  id: row.id,
  session_no: row.session_no,
  status: row.status,
});

/** GET — the caller's own thread. Also their heartbeat, since this is the poll. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { searchParams } = new URL(request.url);

  const prepared = await prepare(searchParams.get('email'));
  if (!prepared.ok) return prepared.response;
  const { sb, workEmail } = prepared;

  const session = await readOwnSession(sb, id, workEmail);
  if (!session.ok) {
    if (session.reason === 'not_migrated') {
      return NextResponse.json({ migrated: false, session: null, messages: [], error: null });
    }
    if (session.reason === 'error') {
      return NextResponse.json(
        { migrated: true, session: null, messages: [], error: session.message },
        { status: 500 },
      );
    }
    return NextResponse.json({ session: null, messages: [], error: NOT_FOUND }, { status: 404 });
  }

  const thread = await readThread(sb, session.row.id);
  if (!thread.migrated) {
    return NextResponse.json({ migrated: false, session: null, messages: [], error: null });
  }
  if (thread.error) {
    return NextResponse.json(
      { migrated: true, session: sessionWire(session.row), messages: [], error: thread.error },
      { status: 500 },
    );
  }

  void beat(sb, session.row.id);

  return NextResponse.json({
    migrated: true,
    session: sessionWire(session.row),
    messages: thread.rows,
    error: null,
  });
}

/**
 * POST — say something.
 *
 * Allowed while 'waiting': a question typed before anybody picks up is how the
 * transcript accumulates, and it is exactly the content an expired chat carries
 * into its ES- ticket. Refused once the session is 'ended' or 'abandoned' —
 * that record is closed, and the refusal says outright that nothing was saved.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  let body: { body?: unknown; email?: string | null };
  try {
    body = ((await request.json()) as { body?: unknown; email?: string | null }) ?? {};
  } catch {
    return NextResponse.json({ message: null, error: 'Invalid request body' }, { status: 400 });
  }

  const prepared = await prepare(body?.email ?? null);
  if (!prepared.ok) return prepared.response;
  const { authz, sb, workEmail } = prepared;

  const session = await readOwnSession(sb, id, workEmail);
  if (!session.ok) {
    if (session.reason === 'not_migrated') {
      return NextResponse.json(
        { migrated: false, message: null, error: 'Live chat is not switched on yet. Nothing was sent.' },
        { status: 503 },
      );
    }
    if (session.reason === 'error') {
      return NextResponse.json({ migrated: true, message: null, error: session.message }, { status: 500 });
    }
    return NextResponse.json({ message: null, error: NOT_FOUND }, { status: 404 });
  }

  if (!(OPEN_STATUSES as readonly string[]).includes(session.row.status)) {
    return NextResponse.json(
      { migrated: true, message: null, error: 'This chat has ended. Nothing was sent.' },
      { status: 409 },
    );
  }

  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!text) {
    return NextResponse.json(
      { migrated: true, message: null, error: 'Type a message to send.' },
      { status: 400 },
    );
  }
  // The DB CHECK is the backstop at 4000; refusing here makes it a sentence the
  // employee can act on instead of a 500. Deliberately the ticket side's bound
  // and not a second constant: the chat SQL ships the same 4000 "so a transcript
  // can be carried into a ticket without a message becoming illegal on the way",
  // and two constants for one rule is how that stops being true.
  if (text.length > SUPPORT_CONCERN_MAX) {
    return NextResponse.json(
      {
        migrated: true,
        message: null,
        error: `That message is too long (max ${SUPPORT_CONCERN_MAX} characters). Nothing was sent.`,
      },
      { status: 400 },
    );
  }

  // Screening records; it never refuses. Both flag columns are derived from the
  // ONE value, so the both-or-neither CHECK holds by construction rather than by
  // two expressions somebody has to keep agreeing.
  const verdict = screenText(text);
  const flagReason = verdict.flagged ? verdict.reason : null;
  const flaggedAt = flagReason ? new Date().toISOString() : null;

  const { data, error } = await sb
    .from(MESSAGES_TABLE)
    .insert({
      session_id: session.row.id,
      author_side: 'employee',
      // The session is the answer; the body was only ever a request.
      author_email: authz.effectiveEmail,
      // From the session row, not a fresh master-list read: the name on a chat
      // is the name it was opened under, and it must not change mid-transcript
      // because a sheet was re-uploaded while somebody was typing.
      author_name: session.row.member_name,
      body: text,
      flagged_at: flaggedAt,
      flag_reason: flagReason,
    })
    .select(MESSAGE_SELECT)
    .limit(1);

  if (error) {
    if (classifyTableProbe(error) === 'MISSING') {
      return NextResponse.json(
        { migrated: false, message: null, error: 'Live chat is not switched on yet. Nothing was sent.' },
        { status: 503 },
      );
    }
    return NextResponse.json({ migrated: true, message: null, error: error.message }, { status: 500 });
  }

  const row = (data?.[0] as ChatMessageRow | undefined) ?? null;
  if (!row) {
    return NextResponse.json(
      { migrated: true, message: null, error: 'The message was not saved. Please try again.' },
      { status: 500 },
    );
  }

  announce(session.row.id, 'message');

  return NextResponse.json({ migrated: true, message: row, error: null });
}
