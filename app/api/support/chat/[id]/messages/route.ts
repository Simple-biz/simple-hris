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
import { lookupFullNameForEmail } from '@/lib/supabase/announcements';
import { broadcastFromServer } from '@/lib/supabase/realtime-broadcast';
import { resolveWebhookUrl } from '@/lib/webhooks/resolve-webhook';
import { recordNotifyFailure } from '@/lib/notifications/notify-failure-audit';
import { CHAT_LIVE_EVENT, CHAT_LIVE_TOPIC, type ChatLivePayload } from '@/lib/support/chat-live';
import { CHAT_OPEN_STATUSES, formatChatSessionNo, type ChatSessionStatus } from '@/lib/support/chat-types';
import { screenText } from '@/lib/support/screening';
import { staffReplyRecipient } from '@/lib/support/recipients';
import { SUPPORT_CONCERN_MAX } from '@/lib/support/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Employee Support LIVE CHAT — the AGENT's side of one conversation.
 *
 * Plan: docs/superpowers/plans/2026-09-19-employee-support-chat.md (task 12).
 * Table: references/sql/create/2026-09-19_employee_support_chat.sql.
 *
 *   GET  → { migrated, session, messages }  the whole thread, oldest first,
 *          WITH the screening flags — they are a note to the staffer.
 *   POST → { body } one agent reply. Screened, never blocked. Writes the
 *          message, moves the session to 'live', and on the FIRST reply fires
 *          the in-app notification and the n8n email leg.
 *
 * THE MIRROR OF `app/api/employee/support/chat/[id]/messages/route.ts`
 * ---------------------------------------------------------------------------
 * Same table, same statuses, same 4000-character bound, same screening rule.
 * Three things differ, and each is deliberate:
 *
 * 1. **The projection is wider.** `author_email`, `flagged_at` and
 *    `flag_reason` are returned here and withheld there. The flag exists to
 *    tell the person about to reply what they are walking into; handing it to
 *    the employee about their own message turns a reading aid into an
 *    accusation.
 * 2. **The gate is the feature, not the owner.** There is ONE global queue and
 *    every agent is qualified for everything (Kane, 2026-09-19), so an agent
 *    may READ any session. They may only WRITE to one they hold.
 * 3. **404 is not hiding anything here, and still says nothing.** The
 *    employee's route collapses "malformed", "missing" and "not yours" into one
 *    404 because a 403 would confirm a stranger's session exists. An agent is
 *    entitled to know a session exists, so the same 404 is simply the honest
 *    answer to "no such chat" — the one sentence is kept anyway, so the two
 *    routes cannot drift into distinguishable replies.
 *
 * ONE GUARDED UPDATE, NOT A SECOND LOOSENED ONE
 * ---------------------------------------------------------------------------
 * A reply does **not** claim an unclaimed chat. The claim is a compare-and-set
 * on NULL and it lives in `app/api/support/chat/queue/route.ts`; replying to a
 * `waiting` session is refused with a 409 that says to claim it first. Widening
 * this route to "claim if unclaimed" would be exactly the one loosened UPDATE
 * the plan's invariant (`:95-96`) forbids.
 *
 * A FLAG NEVER BLOCKS — INCLUDING ON THIS SIDE OF THE DESK
 * ---------------------------------------------------------------------------
 * `screenText` runs on the agent's words too. Not as a trap: Carla asked for
 * "unprofessional behavior" to be flagged, and a channel that screens only the
 * person complaining and not the company answering it is not a screen, it is
 * surveillance. It records and delivers, exactly as it does everywhere else.
 */

const SESSIONS_TABLE = 'employee_support_chat_sessions';
const MESSAGES_TABLE = 'employee_support_chat_messages';

/** The feature key from the `employee_support` catalog (`feature-permissions.ts:121`). */
const SUPPORT_CHAT_FEATURE = 'support_chat';

/** The three OPEN statuses — typed against the vocabulary, never bare strings. */
const OPEN_STATUSES = [...CHAT_OPEN_STATUSES] as ChatSessionStatus[];

/** One sentence for every "no such chat" outcome, so the branches cannot drift. */
const NOT_FOUND = 'Chat not found.';

/** Postgres `uuid` literals only, so a malformed id is a 404 and not a 22P02. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SESSION_SELECT =
  'id, session_no, status, work_email, member_name, department, queued_at, claimed_by, claimed_at, became_ticket_id';
/** Wider than the employee projection: author_email and both flag columns. */
const MESSAGE_SELECT =
  'id, author_side, author_email, author_name, body, flagged_at, flag_reason, created_at';

type ChatSessionRow = {
  id: string;
  session_no: number;
  status: ChatSessionStatus;
  work_email: string;
  member_name: string | null;
  department: string | null;
  queued_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
  became_ticket_id: string | null;
};

type ChatMessageRow = {
  id: string;
  author_side: 'employee' | 'agent' | 'system';
  author_email: string | null;
  author_name: string | null;
  body: string;
  flagged_at: string | null;
  flag_reason: string | null;
  created_at: string;
};

/**
 * Why a session lookup failed, as a VALUE rather than a finished response.
 *
 * GET and POST owe different answers to the same failure — a missing migration
 * is a readable "nothing here yet" for a reader and a 503 "nothing was sent"
 * for a writer — so the lookup reports what happened and each verb decides the
 * status. The same shape the employee's route uses, for the same reason.
 */
type SessionLookupFailure =
  | { reason: 'not_found' }
  | { reason: 'not_migrated' }
  | { reason: 'error'; message: string };

/** The FACT that this thread moved. No body, no email — see `chat-live.ts`. */
function announce(sessionId: string, kind: ChatLivePayload['kind']): void {
  void broadcastFromServer(CHAT_LIVE_TOPIC, CHAT_LIVE_EVENT, {
    ...({ kind, sessionId, ts: Date.now() } satisfies ChatLivePayload),
  });
}

/**
 * Origin used for links inside the email leg.
 *
 * Mirrors `src/lib/tickets/notify.ts:15-21`, which is private to that module.
 * Restated rather than exported-from-there because that file belongs to the
 * dev-board feature and this one must not start importing out of it; the rule
 * is the same and it is written down in both places: `NEXTAUTH_URL` is
 * localhost during dev, which is a link nobody's inbox can open.
 */
function publicOrigin(): string {
  const raw = (process.env.NEXTAUTH_URL ?? '').trim().replace(/\/$/, '');
  if (!raw || /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|192\.168\.|10\.)/i.test(raw)) {
    return 'https://simple-hris.vercel.app';
  }
  return raw;
}

/**
 * Gate + client. READS take `view`; the REPLY takes `edit`.
 *
 * This diverges from `app/api/tickets/[id]/comments/route.ts:43-46`, which
 * gates a reply at `view` so a "View only" HR member can still answer a
 * question on their own dev ticket. Speaking as Employee Support is not that:
 * the thread carries pay disputes and complaints naming a manager, and somebody
 * granted `view` and not `edit` on this catalog was deliberately held back from
 * answering them. Nothing is loosened by the divergence — granting the
 * `employee_support` role auto-provisions `edit` (`provisionDashboardTabs`), so
 * the five answerers are unaffected.
 */
async function prepare(
  level: 'view' | 'edit',
): Promise<{ ok: true; authz: AuthzOk; sb: SupabaseClient } | { ok: false; response: NextResponse }> {
  const authz = await requireFeatureAccessAnyView(SUPPORT_CHAT_FEATURE, level);
  if (!authz.ok) return { ok: false, response: deniedResponse(authz) };

  const sb = createSupabaseServiceRoleClient();
  if (!sb) {
    // No `migrated` in this body: nothing has asked the database anything, so
    // nothing here may claim an answer about whether the migration ran.
    return {
      ok: false,
      response: NextResponse.json({ error: 'Support chat is unavailable right now.' }, { status: 503 }),
    };
  }
  return { ok: true, authz, sb };
}

/** The session at `id`. Any agent may read any session — one global queue. */
async function readSession(
  sb: SupabaseClient,
  id: string,
): Promise<{ ok: true; row: ChatSessionRow } | ({ ok: false } & SessionLookupFailure)> {
  if (!UUID_RE.test(id)) return { ok: false, reason: 'not_found' };

  const { data, error } = await sb.from(SESSIONS_TABLE).select(SESSION_SELECT).eq('id', id).limit(1);
  if (error) {
    if (classifyTableProbe(error) === 'MISSING') return { ok: false, reason: 'not_migrated' };
    return { ok: false, reason: 'error', message: error.message };
  }
  const row = (data?.[0] as ChatSessionRow | undefined) ?? null;
  if (!row) return { ok: false, reason: 'not_found' };
  return { ok: true, row };
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
    // Both chat tables ship in one file, so a present sessions table with an
    // absent messages table is a half-applied migration — still "not
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
  work_email: row.work_email,
  member_name: row.member_name,
  department: row.department,
  queued_at: row.queued_at,
  claimed_by: row.claimed_by,
  claimed_at: row.claimed_at,
});

/**
 * The n8n EMAIL leg for an agent's first reply. Slug `support_chat_replied`
 * (plan `:204`).
 *
 * **The recipient is decided in code and handed over as `send_to`; the Gmail
 * node never picks one** (`docs/features/tickets-board.md:63-112`). It is the
 * shipped `staffReplyRecipient` rule and not a new one — a staff reply goes to
 * the employee who asked, always.
 *
 * **Returns early on `null`, never on `''`.** n8n's Gmail node is
 * stop-on-error: an empty `To` fails the whole workflow run rather than
 * skipping one message, which is how the orientation-email Invalid-To incident
 * happened. No-op when no webhook is configured; never throws — the reply is
 * already saved and the caller `void`s this.
 */
async function notifyChatReplied(input: {
  session: ChatSessionRow;
  agentName: string | null;
  agentEmail: string;
  body: string;
}): Promise<void> {
  try {
    const sendTo = staffReplyRecipient({
      work_email: input.session.work_email,
      claimed_by: input.session.claimed_by,
    });
    if (!sendTo) return;

    const url = await resolveWebhookUrl('support_chat_replied', {
      envVars: ['N8N_SUPPORT_CHAT_REPLIED_WEBHOOK_URL'],
    });
    if (!url) return;

    const origin = publicOrigin();
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'support_chat.replied',
        send_to: sendTo,
        session_no: input.session.session_no,
        session_label: formatChatSessionNo(input.session.session_no),
        member_name: input.session.member_name ?? '',
        replied_by: input.agentName ?? input.agentEmail,
        // A PREVIEW, not the thread. The email is a nudge to come and read it;
        // posting a pay dispute's full text into an inbox is a second copy of
        // HR-grade content living somewhere nobody gated.
        preview: `${input.body.slice(0, 140)}${input.body.length > 140 ? '…' : ''}`,
        replied_at: new Date().toISOString(),
        chat_url: `${origin}/employee`,
      }),
      // Bound the call so a slow or unreachable n8n cannot hang the reply.
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Best-effort only — the reply is already saved.
  }
}

/* ───────────────────────────────── GET ──────────────────────────────────── */

/** GET — the whole thread, flags included. Any agent may read any session. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const prepared = await prepare('view');
  if (!prepared.ok) return prepared.response;
  const { sb } = prepared;

  const session = await readSession(sb, id);
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

  return NextResponse.json({
    migrated: true,
    session: sessionWire(session.row),
    messages: thread.rows,
    error: null,
  });
}

/* ──────────────────────────────── POST ──────────────────────────────────── */

/**
 * POST — say something to the employee.
 *
 * WHY THE MESSAGE IS WRITTEN BEFORE THE STATUS MOVES
 * ---------------------------------------------------------------------------
 * The two writes can fail independently, and the failure directions are not
 * equally bad:
 *
 * * Status first, message second: a failed insert leaves a `live` session with
 *   no agent line in it. The employee was told nothing, and when they leave,
 *   the sweep reads `live` as "a conversation happened" and ends it **without
 *   an ES- ticket**. That is the promise silently dropped.
 * * Message first, status second: a failed flip leaves a `claimed` session that
 *   has in fact been answered. When the employee leaves, the sweep converts it
 *   to a ticket carrying the full transcript — an extra ticket, visibly already
 *   answered, which a staffer closes in one click.
 *
 * So the message goes first. It is the same rule `abandonment.ts` states about
 * every uncertain case: the doubt is spent on the employee's side.
 *
 * The flip is still a **compare-and-set on the CURRENT holder**
 * (`WHERE status = 'claimed' AND claimed_by = <me>`), which does double duty:
 * it is the transition, and a row coming back is proof this was the FIRST
 * reply — which is what the notification and the email leg key off.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  let payload: { body?: unknown };
  try {
    payload = ((await request.json()) as { body?: unknown }) ?? {};
  } catch {
    return NextResponse.json({ message: null, error: 'Invalid request body' }, { status: 400 });
  }

  const prepared = await prepare('edit');
  if (!prepared.ok) return prepared.response;
  const { authz, sb } = prepared;

  // The agent IS the session, never the body.
  const agent = normEmail(authz.sessionEmail);
  if (!agent) return NextResponse.json({ message: null, error: 'Not signed in' }, { status: 401 });

  const session = await readSession(sb, id);
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
  const row = session.row;

  if (!OPEN_STATUSES.includes(row.status)) {
    return NextResponse.json(
      { migrated: true, message: null, error: 'This chat has ended. Nothing was sent.' },
      { status: 409 },
    );
  }
  if (row.status === 'waiting') {
    // NEVER an implicit claim. The claim is a compare-and-set on NULL and it
    // belongs to the queue route; doing it here as a side effect of typing is
    // the one loosened UPDATE the invariant forbids.
    return NextResponse.json(
      {
        migrated: true,
        message: null,
        error: 'Claim this chat before replying. Nothing was sent.',
      },
      { status: 409 },
    );
  }
  if (normEmail(row.claimed_by) !== agent) {
    // One agent holds one conversation. A second voice arriving mid-thread
    // reads to the employee as two people answering one question.
    return NextResponse.json(
      {
        migrated: true,
        message: null,
        error: 'Somebody else is holding this chat. Nothing was sent — refresh the queue.',
      },
      { status: 409 },
    );
  }

  const text = typeof payload.body === 'string' ? payload.body.trim() : '';
  if (!text) {
    return NextResponse.json(
      { migrated: true, message: null, error: 'Type a message to send.' },
      { status: 400 },
    );
  }
  // The DB CHECK is the backstop at 4000; refusing here makes it a sentence the
  // agent can act on. Deliberately the ticket side's shared bound and not a
  // second constant — the chat SQL ships the same 4000 "so a transcript can be
  // carried into a ticket without a message becoming illegal on the way".
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

  // Screening records; it never refuses. Both flag columns come from the ONE
  // verdict, so `..._flag_both_or_neither` holds by construction.
  const verdict = screenText(text);
  const flagReason = verdict.flagged ? verdict.reason : null;
  const flaggedAt = flagReason ? new Date().toISOString() : null;

  const agentName = await lookupFullNameForEmail(authz.sessionEmail);

  const { data, error } = await sb
    .from(MESSAGES_TABLE)
    .insert({
      session_id: row.id,
      author_side: 'agent',
      author_email: agent,
      author_name: agentName,
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

  const message = (data?.[0] as ChatMessageRow | undefined) ?? null;
  if (!message) {
    return NextResponse.json(
      { migrated: true, message: null, error: 'The message was not saved. Please try again.' },
      { status: 500 },
    );
  }

  // The transition, guarded on the CURRENT holder. A row back means this was
  // the first reply on this session; zero rows means it was already `live`
  // (the ordinary case for every message after the first) or that the claim
  // moved under us between the read above and here — the message stands either
  // way, and the transcript records who said it.
  const flipped = await sb
    .from(SESSIONS_TABLE)
    .update({ status: 'live' })
    .eq('id', row.id)
    .eq('status', 'claimed')
    .eq('claimed_by', agent)
    .select('id');
  const firstReply = !flipped.error && !!flipped.data && flipped.data.length > 0;

  // ONE broadcast, and `message` is the right kind even though the status also
  // moved: the employee's listener answers a matching `message` with
  // `fire(true)`, which re-runs the session GET *and* the thread
  // (`EmployeeSupportChat.tsx:655-676`). A second `session` frame would buy
  // nothing and would fan out to every other employee in the line.
  announce(row.id, 'message');

  if (firstReply) {
    void insertAuditLog({
      ...auditFrom(request, authz),
      action: 'employee_support.chat.replied',
      resource: SESSIONS_TABLE,
      resource_id: row.id,
      details: { session_no: row.session_no, work_email: row.work_email },
    });

    // ONE CHIME PER CONVERSATION, NOT ONE PER SENTENCE. The employee is either
    // watching the dialog (10s poll) or has it shut (45s poll) — both catch
    // every later line. A notification per typed line would make the one that
    // matters, "support has picked you up", indistinguishable from noise.
    //
    // `null` never `''`: the recipient is resolved by the shipped rule, and an
    // empty `recipient_email` is a row nobody can ever read.
    const recipient = staffReplyRecipient({
      work_email: row.work_email,
      claimed_by: row.claimed_by,
    });
    if (recipient) {
      const notif = await sb.from('employee_notifications').insert({
        recipient_email: recipient,
        type: 'support_chat.replied',
        tone: 'neutral',
        title: 'Support has joined your chat',
        message: `${agentName ?? 'Support'} replied in your live chat ${formatChatSessionNo(row.session_no)}.`,
        details: {
          session_id: row.id,
          session_no: row.session_no,
          message_id: message.id,
          author_email: agent,
        },
      });
      if (notif.error) {
        // NOT a console line. `kpi.scored` delivered nothing for three days
        // because a type-CHECK rejection looked identical to success
        // (`notify-failure-audit.ts:4-12`), and `support_chat.replied` is
        // rejected by exactly that constraint until task 16's DDL runs.
        void recordNotifyFailure({
          notificationType: 'support_chat.replied',
          origin: 'support/chat/[id]/messages',
          error: notif.error,
          actor: { user_name: authz.sessionEmail, user_role: authz.roles[0] ?? 'user' },
          details: { session_no: row.session_no },
        });
      }
    }

    void notifyChatReplied({
      session: row,
      agentName,
      agentEmail: agent,
      body: text,
    });
  }

  return NextResponse.json({ migrated: true, message, error: null });
}
