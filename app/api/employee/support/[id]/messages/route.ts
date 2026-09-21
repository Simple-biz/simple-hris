import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authorizeEmailAccess, deniedResponse, type AuthzOk } from '@/lib/auth/authorize-email';
import { auditFrom } from '@/lib/audit/context';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { classifyColumnProbe, classifyTableProbe } from '@/lib/db/probe-verdict';
import { getEmployeeMasterRecord } from '@/lib/supabase/employees';
import { normEmail } from '@/lib/email/norm-email';
import { broadcastFromServer } from '@/lib/supabase/realtime-broadcast';
import { resolveWebhookUrl } from '@/lib/webhooks/resolve-webhook';
import { TICKET_LIVE_EVENT, TICKET_LIVE_TOPIC, type TicketLivePayload } from '@/lib/support/ticket-live';
import { screenText } from '@/lib/support/screening';
import { employeeReplyRecipient } from '@/lib/support/recipients';
import { canEmployeeReply, nextStatus, type LifecycleTicket } from '@/lib/support/lifecycle';
import { isSupportPriority } from '@/lib/support/triage';
import {
  SUPPORT_CATEGORY_LABELS,
  SUPPORT_CONCERN_MAX,
  SUPPORT_STATUS_LABELS,
  formatSupportTicketNo,
  isSupportCategory,
  needsStaffReply,
  type SupportAuthorSide,
  type SupportStatus,
} from '@/lib/support/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Employee Support TICKETS — the thread of ONE of the caller's own tickets.
 *
 * Plan: docs/superpowers/plans/2026-09-14-employee-support.md (task 9).
 * Tables: references/sql/create/2026-09-16_employee_support.sql plus the
 * triage ALTER — the same two the collection route requires, for the reason
 * its header gives.
 *
 *   GET  → { migrated, ticket, messages }  the ticket and every reply, oldest
 *          first. The ticket's own `concern` is the opening message and is
 *          NOT duplicated into `messages` — the UI renders it first, then the
 *          thread. That is the SQL's own description of the two tables.
 *   POST → { body, email? }  one employee reply. Screened, never blocked. An
 *          employee reply to a CLOSED ticket REOPENS it.
 *
 * 404, NOT 403, ON SOMEBODY ELSE'S ID
 * ---------------------------------------------------------------------------
 * A 403 is an answer: it confirms the id names a real ticket. Every rejection
 * here — a malformed id, an id that does not exist, an id belonging to another
 * employee — returns the same 404 with the same sentence, so the response says
 * nothing about which of the three happened. The ownership test is the LAST
 * thing that runs in the lookup, for the same reason. Same rule as
 * /api/employee/documents/[id] and the chat thread route beside this one.
 *
 * THE REOPEN — CARLA'S "EITHER SIDE CAN REPLY AGAIN", AND WHO DECIDES IT
 * ---------------------------------------------------------------------------
 * This route does not know the rule. `canEmployeeReply` (lifecycle.ts) returns
 * the verdict and `nextStatus('reply', ticket, 'employee')` returns the status
 * it moves to; this file enforces them. The asymmetry — an EMPLOYEE reply to a
 * closed ticket reopens it, a STAFF reply does not — is deliberate and is
 * argued in lifecycle.ts, not here: an employee coming back to a closed thread
 * is saying it was not actually resolved.
 *
 * The reopen is a COMPARE-AND-SET: `UPDATE … WHERE id = ? AND status =
 * 'closed'`. Zero rows back means somebody reopened it between the read and
 * this write, and that is not an error — the ticket is open, which is what
 * was wanted. The condition that formed the verdict is repeated in the WHERE
 * so a stale read can never move a ticket that is no longer in the state the
 * decision was made about.
 *
 * ORDER OF WRITES: the message first, then the status. If the reopen fails the
 * employee's words are still on the record and the next reply retries the
 * reopen for free; the other order could reopen a ticket and then lose the
 * reply that reopened it, which is a ticket back in somebody's count with
 * nothing new to read. One window is left open knowingly: a ticket closed by
 * staff between this route's read and its insert receives the reply without
 * reopening. The next employee reply reopens it; the alternative — an
 * unconditional CAS after every insert — would take the decision away from the
 * module that owns it.
 *
 * `first_response_at`, `claimed_by` and `closed_by`/`closed_at` are NOT
 * touched. The first answer was given when it was given; whoever held the
 * ticket still held it; and the SQL says outright that "a closed_at with a
 * later reopen is a legitimate state this table allows" — the row keeps its
 * history and `audit_log` records the reopen.
 *
 * A FLAG NEVER BLOCKS, AND THE EMPLOYEE NEVER SEES IT
 * ---------------------------------------------------------------------------
 * `screenText` runs on every employee reply and records what it saw; the reply
 * is saved either way (screening.ts). `flagged_at` / `flag_reason` are not in
 * the employee projection: a flag is a note to the staffer who reads the
 * thread.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 * * **No in-app notification.** `support.replied` and `support.answered` are
 *   both mapped to `['employee']` (plan task 14) — there is no type for a
 *   STAFF recipient, and inventing one is DDL that must be re-read against the
 *   live constraint first. The holder hears by email (below) and the board
 *   shows the thread; that is `recipients.ts`'s answer — "a panel row is
 *   cheap, an inbox is not" — stated from the employee's side.
 * * **No `author_email` on the wire.** A staffer's name reaches the employee
 *   through `author_name`; their address is not the employee's to have.
 * * **No edit and no delete.** The messages table has no `updated_at` and no
 *   edit path. A support thread is a record of what was said.
 * * **No status transition but the reopen.** `answered` stays `answered` when
 *   the employee follows up — `nextStatus` says so. That leaves the staff
 *   board with no "employee replied since" signal on an answered ticket;
 *   noted for the staff side, not solved here by re-deriving a rule.
 * * **No `updated_at` bump on the ticket for a plain reply.** The normalising
 *   trigger stamps it on UPDATE only, and a message is an INSERT on another
 *   table. Writing a no-op UPDATE to fire the trigger would be a second writer
 *   racing the staff routes for nothing the thread does not already show.
 */

const TICKETS_TABLE = 'employee_support_tickets';
const MESSAGES_TABLE = 'employee_support_messages';

/**
 * One sentence for every "this is not your ticket" outcome. A constant, so the
 * three branches cannot drift into three distinguishable answers — which is
 * how a 404 quietly turns back into a 403.
 */
const NOT_FOUND = 'Ticket not found.';
const NOT_MIGRATED = 'Employee Support tickets are not switched on yet. Nothing was sent.';
const UNAVAILABLE = 'Employee Support is unavailable right now.';

/** Postgres `uuid` literals only, so a malformed id is a 404 here and not a 22P02 from PostgREST. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Identical to the collection route's, and for the same reasons. */
const TICKET_SELECT =
  'id, ticket_no, work_email, member_name, category, concern, status, priority, claimed_by, claimed_at, first_response_at, closed_at, created_at, updated_at';

/** No `author_email`, no flag columns — see the header. */
const MESSAGE_SELECT = 'id, author_side, author_name, body, created_at';

type TicketDbRow = {
  id: string;
  ticket_no: number;
  work_email: string;
  member_name: string | null;
  category: string;
  concern: string;
  status: SupportStatus;
  priority: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  first_response_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
};

/** What the employee is handed back per reply. */
type MessageWire = {
  id: string;
  author_side: SupportAuthorSide;
  author_name: string | null;
  body: string;
  created_at: string;
};

/** Same shape as the collection route's `thread`, computed here from the full thread. */
type ThreadSummary = {
  messages: number;
  staff_replies: number;
  last_message_at: string | null;
  last_message_side: SupportAuthorSide | null;
  last_staff_reply_at: string | null;
  awaiting_you: boolean;
};

/** Same projection as the collection route. The two must not drift — the UI renders one type. */
type EmployeeTicketWire = {
  id: string;
  ticket_no: number;
  label: string;
  category: string;
  category_label: string;
  concern: string;
  status: SupportStatus;
  status_label: string;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  first_response_at: string | null;
  closed_at: string | null;
  needs_staff_reply: boolean;
  thread: ThreadSummary | null;
};

/**
 * Why a ticket lookup failed, as a VALUE rather than a pre-rendered response.
 *
 * GET and POST owe different answers to the same failure — a missing migration
 * is a readable "nothing here yet" for a reader and a 503 "nothing was sent"
 * for a writer — so the lookup reports what happened and each verb decides the
 * status and the shape.
 */
type TicketLookupFailure =
  | { reason: 'not_found' }
  | { reason: 'not_migrated' }
  | { reason: 'error'; message: string };

type Identity = { work_email: string; member_name: string | null };

/**
 * Gate, client, and the caller's canonical work email.
 *
 * `work_email` is resolved from the master list exactly as the collection
 * route resolves it, because the two routes must agree about who owns a
 * ticket. A master-list READ FAILURE stops the request rather than falling
 * back to the signed-in address: a wrong key here would 404 an employee out of
 * their own question.
 *
 * Neither failure body carries `migrated` — nothing here has asked the
 * database whether the migration ran, so nothing here may claim an answer.
 */
async function prepare(
  requestedEmail: string | null,
): Promise<
  | { ok: true; authz: AuthzOk; sb: SupabaseClient; identity: Identity }
  | { ok: false; response: NextResponse }
> {
  const authz = await authorizeEmailAccess(requestedEmail);
  if (!authz.ok) return { ok: false, response: deniedResponse(authz) };

  const sb = createSupabaseServiceRoleClient();
  if (!sb) {
    return { ok: false, response: NextResponse.json({ error: UNAVAILABLE }, { status: 503 }) };
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

  return {
    ok: true,
    authz,
    sb,
    identity: {
      work_email: normEmail(employee?.work_email) ?? authz.effectiveEmail,
      member_name: employee?.name?.trim() || null,
    },
  };
}

/* ─────────────────────────────── reads ──────────────────────────────────── */

/** The ticket at `id`, but ONLY if it belongs to the caller. */
async function readOwnTicket(
  sb: SupabaseClient,
  id: string,
  workEmail: string,
): Promise<{ ok: true; row: TicketDbRow } | ({ ok: false } & TicketLookupFailure)> {
  if (!UUID_RE.test(id)) return { ok: false, reason: 'not_found' };

  const { data, error } = await sb.from(TICKETS_TABLE).select(TICKET_SELECT).eq('id', id).limit(1);
  if (error) {
    if (classifyColumnProbe(error) === 'MISSING') return { ok: false, reason: 'not_migrated' };
    return { ok: false, reason: 'error', message: error.message };
  }

  const row = (data?.[0] as TicketDbRow | undefined) ?? null;
  // Existence and ownership collapse into the same answer, on purpose.
  if (!row || row.work_email !== workEmail) return { ok: false, reason: 'not_found' };
  return { ok: true, row };
}

/** The thread, oldest first. A thread is a SET, so it pages. */
async function readThread(
  sb: SupabaseClient,
  ticketId: string,
): Promise<{ rows: MessageWire[]; error: string | null; migrated: boolean }> {
  const { rows, error } = await selectAllPaged<MessageWire>((from, to) =>
    sb
      .from(MESSAGES_TABLE)
      .select(MESSAGE_SELECT)
      .eq('ticket_id', ticketId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (error) {
    // Both tables ship in one file, so a present tickets table with an absent
    // messages table is a half-applied migration — still "not migrated",
    // never an empty thread presented as the truth.
    if (classifyTableProbe({ message: error }) === 'MISSING') {
      return { rows: [], error: null, migrated: false };
    }
    return { rows: [], error, migrated: true };
  }
  return { rows, error: null, migrated: true };
}

/* ─────────────────────────────── shapes ─────────────────────────────────── */

/**
 * The summary the collection route computes from stamps, computed here from
 * the full thread. Rows are in `(created_at, id)` order, so the last one seen
 * is the latest — same fold, same meaning.
 */
function summarize(messages: readonly MessageWire[]): ThreadSummary {
  const s: ThreadSummary = {
    messages: 0,
    staff_replies: 0,
    last_message_at: null,
    last_message_side: null,
    last_staff_reply_at: null,
    awaiting_you: false,
  };
  for (const m of messages) {
    s.messages += 1;
    s.last_message_at = m.created_at;
    s.last_message_side = m.author_side;
    if (m.author_side === 'staff') {
      s.staff_replies += 1;
      s.last_staff_reply_at = m.created_at;
    }
  }
  s.awaiting_you = s.last_message_side === 'staff';
  return s;
}

function toWire(row: TicketDbRow, thread: ThreadSummary | null): EmployeeTicketWire {
  return {
    id: row.id,
    ticket_no: row.ticket_no,
    label: formatSupportTicketNo(row.ticket_no),
    category: row.category,
    category_label: isSupportCategory(row.category) ? SUPPORT_CATEGORY_LABELS[row.category] : row.category,
    concern: row.concern,
    status: row.status,
    status_label: SUPPORT_STATUS_LABELS[row.status],
    created_at: row.created_at,
    updated_at: row.updated_at,
    claimed_at: row.claimed_at,
    first_response_at: row.first_response_at,
    closed_at: row.closed_at,
    needs_staff_reply: needsStaffReply(row),
    thread,
  };
}

/**
 * Enough of the row for lifecycle.ts to judge. `priority` is NARROWED, not
 * asserted: `isSupportPriority` is the guard `triage.ts` owns, and anything it
 * does not recognise reads as `null`. `canEmployeeReply` does not look at it,
 * but the type is the module's contract and this route does not get to lie to
 * it with a value it did not read.
 */
function lifecycleOf(row: TicketDbRow): LifecycleTicket {
  return {
    status: row.status,
    priority: isSupportPriority(row.priority) ? row.priority : null,
    claimed_by: row.claimed_by,
  };
}

/** THE FACT that this thread moved. No body, no email — see the collection route's header. */
function announce(ticketId: string, kind: TicketLivePayload['kind']): void {
  void broadcastFromServer(TICKET_LIVE_TOPIC, TICKET_LIVE_EVENT, {
    ...({ kind, ticketId, ts: Date.now() } satisfies TicketLivePayload),
  });
}

/** See `src/lib/tickets/notify.ts`: a localhost NEXTAUTH_URL is a link nobody's inbox can open. */
function publicOrigin(): string {
  const raw = (process.env.NEXTAUTH_URL ?? '').trim().replace(/\/$/, '');
  if (!raw || /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|192\.168\.|10\.)/i.test(raw)) {
    return 'https://simple-hris.vercel.app';
  }
  return raw;
}

/**
 * The n8n EMAIL leg for an employee's reply. Slug `support_replied` — the same
 * slug the staff reply uses in the other direction, the way the dev board's
 * one `ticket_replied` serves both; `recipient_is_employee` tells the
 * workflow which way this one is facing.
 *
 * **The recipient is decided in code and handed over as `send_to`.**
 * `employeeReplyRecipient` returns the HOLDER or `null` — never `''`, and
 * deliberately never "all five" for an unclaimed ticket (recipients.ts: the
 * line is the cheap channel, five inboxes are the expensive one). Returns
 * early on null, no-op when no webhook is configured, never throws — the reply
 * is already saved and the caller `void`s this.
 */
async function notifyEmployeeReplied(input: {
  ticket: TicketDbRow;
  body: string;
  reopened: boolean;
}): Promise<void> {
  try {
    const sendTo = employeeReplyRecipient({
      work_email: input.ticket.work_email,
      claimed_by: input.ticket.claimed_by,
    });
    if (!sendTo) return;

    const url = await resolveWebhookUrl('support_replied', {
      envVars: ['N8N_SUPPORT_REPLIED_WEBHOOK_URL'],
    });
    if (!url) return;

    const origin = publicOrigin();
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'support.replied',
        send_to: sendTo,
        recipient_is_employee: false,
        ticket_no: input.ticket.ticket_no,
        label: formatSupportTicketNo(input.ticket.ticket_no),
        member_name: input.ticket.member_name ?? '',
        work_email: input.ticket.work_email,
        replied_by: input.ticket.member_name ?? input.ticket.work_email,
        // A PREVIEW, not the reply — the email is a nudge to open the board.
        preview: `${input.body.slice(0, 140)}${input.body.length > 140 ? '…' : ''}`,
        reopened: input.reopened,
        replied_at: new Date().toISOString(),
        board_url: `${origin}/tickets`,
      }),
      // Bound the call so a slow or unreachable n8n cannot hang the reply.
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Best-effort only — the reply is already saved.
  }
}

/* ──────────────────────────────── GET ───────────────────────────────────── */

/** GET — the caller's own ticket and its thread. Closed tickets are readable: Carla signed that. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { searchParams } = new URL(request.url);

  const prepared = await prepare(searchParams.get('email'));
  if (!prepared.ok) return prepared.response;
  const { sb, identity } = prepared;

  const found = await readOwnTicket(sb, id, identity.work_email);
  if (!found.ok) {
    if (found.reason === 'not_migrated') {
      return NextResponse.json({ migrated: false, ticket: null, messages: [], error: null });
    }
    if (found.reason === 'error') {
      return NextResponse.json(
        { migrated: true, ticket: null, messages: [], error: found.message },
        { status: 500 },
      );
    }
    return NextResponse.json({ ticket: null, messages: [], error: NOT_FOUND }, { status: 404 });
  }

  const thread = await readThread(sb, found.row.id);
  if (!thread.migrated) {
    return NextResponse.json({ migrated: false, ticket: null, messages: [], error: null });
  }
  if (thread.error) {
    return NextResponse.json(
      { migrated: true, ticket: toWire(found.row, null), messages: [], error: thread.error },
      { status: 500 },
    );
  }

  return NextResponse.json({
    migrated: true,
    ticket: toWire(found.row, summarize(thread.rows)),
    messages: thread.rows,
    error: null,
  });
}

/* ──────────────────────────────── POST ──────────────────────────────────── */

type ReplyBody = { body?: unknown; email?: unknown };

/**
 * POST — reply on your own ticket.
 *
 * Allowed in every status. On a CLOSED ticket the reply reopens it (the
 * header, and lifecycle.ts). The response carries the ticket AFTER the write,
 * the saved message, the whole thread re-read (`null` if that re-read failed —
 * the UI re-fetches), and `reopened`.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  let body: ReplyBody;
  try {
    body = ((await request.json()) as ReplyBody) ?? {};
  } catch {
    return NextResponse.json(
      { ticket: null, message: null, messages: null, reopened: false, error: 'Invalid request body' },
      { status: 400 },
    );
  }

  const prepared = await prepare(typeof body.email === 'string' ? body.email : null);
  if (!prepared.ok) return prepared.response;
  const { authz, sb, identity } = prepared;

  const found = await readOwnTicket(sb, id, identity.work_email);
  if (!found.ok) {
    if (found.reason === 'not_migrated') {
      return NextResponse.json(
        { migrated: false, ticket: null, message: null, messages: null, reopened: false, error: NOT_MIGRATED },
        { status: 503 },
      );
    }
    if (found.reason === 'error') {
      return NextResponse.json(
        { migrated: true, ticket: null, message: null, messages: null, reopened: false, error: found.message },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { ticket: null, message: null, messages: null, reopened: false, error: NOT_FOUND },
      { status: 404 },
    );
  }

  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!text) {
    return NextResponse.json(
      {
        migrated: true,
        ticket: toWire(found.row, null),
        message: null,
        messages: null,
        reopened: false,
        error: 'Type a reply to send.',
      },
      { status: 400 },
    );
  }
  // The DB CHECK is the backstop at 4000; refusing here makes it a sentence
  // the employee can act on instead of a 500. The ticket side's one bound.
  if (text.length > SUPPORT_CONCERN_MAX) {
    return NextResponse.json(
      {
        migrated: true,
        ticket: toWire(found.row, null),
        message: null,
        messages: null,
        reopened: false,
        error: `That reply is too long (max ${SUPPORT_CONCERN_MAX} characters). Nothing was sent.`,
      },
      { status: 400 },
    );
  }

  // THE VERDICT, from the module that owns it. Today it always allows; the
  // branch exists so that if the rule ever changes in lifecycle.ts, this route
  // enforces the new answer without being edited.
  const before = lifecycleOf(found.row);
  const verdict = canEmployeeReply(before);
  if (!verdict.allowed) {
    return NextResponse.json(
      {
        migrated: true,
        ticket: toWire(found.row, null),
        message: null,
        messages: null,
        reopened: false,
        error: `${verdict.reason} Nothing was sent.`,
      },
      { status: 409 },
    );
  }

  // Screening records; it never refuses. Both flag columns derive from the ONE
  // verdict so the `..._flag_both_or_neither` CHECK holds by construction.
  const screening = screenText(text);
  const flagReason = screening.flagged ? screening.reason : null;
  const flaggedAt = flagReason ? new Date().toISOString() : null;

  const inserted = await sb
    .from(MESSAGES_TABLE)
    .insert({
      ticket_id: found.row.id,
      author_side: 'employee',
      // The session is the answer; the body was only ever a request. The chat
      // thread route makes the same choice for the same column.
      author_email: authz.effectiveEmail,
      // From the ticket row, not a fresh master-list read: the name on a
      // thread is the name it was filed under, and it must not change
      // mid-thread because a sheet was re-uploaded.
      author_name: found.row.member_name,
      body: text,
      flagged_at: flaggedAt,
      flag_reason: flagReason,
    })
    .select(MESSAGE_SELECT)
    .limit(1);

  if (inserted.error) {
    if (classifyTableProbe(inserted.error) === 'MISSING') {
      return NextResponse.json(
        { migrated: false, ticket: null, message: null, messages: null, reopened: false, error: NOT_MIGRATED },
        { status: 503 },
      );
    }
    return NextResponse.json(
      {
        migrated: true,
        ticket: toWire(found.row, null),
        message: null,
        messages: null,
        reopened: false,
        error: inserted.error.message,
      },
      { status: 500 },
    );
  }
  const message = (inserted.data?.[0] as MessageWire | undefined) ?? null;
  if (!message) {
    return NextResponse.json(
      {
        migrated: true,
        ticket: toWire(found.row, null),
        message: null,
        messages: null,
        reopened: false,
        error: 'The reply was not saved. Please try again.',
      },
      { status: 500 },
    );
  }

  // THE REOPEN. `verdict.reopens` is the decision and `nextStatus` the
  // destination — both from lifecycle.ts; the WHERE below is the guard.
  let ticketRow = found.row;
  let reopened = false;
  let reopenError: string | null = null;
  const to = nextStatus('reply', before, 'employee');
  if (verdict.reopens && to !== null) {
    const cas = await sb
      .from(TICKETS_TABLE)
      .update({ status: to })
      .eq('id', found.row.id)
      // The compare: the state this decision was made about. A ticket that
      // left `closed` between the read and this write is not moved twice.
      .eq('status', 'closed')
      .select(TICKET_SELECT);
    if (cas.error) {
      // The reply is saved; the ticket stayed closed. Not a failure of the
      // send — the next reply retries the reopen for free — but it is recorded
      // in the audit row so a persistent failure is visible.
      reopenError = cas.error.message;
    } else {
      const after = (cas.data?.[0] as TicketDbRow | undefined) ?? null;
      if (after) {
        ticketRow = after;
        reopened = true;
      } else {
        // Zero rows: somebody else reopened it first. Read the truth back
        // rather than reporting the stale row as still closed.
        const again = await readOwnTicket(sb, found.row.id, identity.work_email);
        if (again.ok) ticketRow = again.row;
      }
    }
  }

  void insertAuditLog({
    ...auditFrom(request, authz),
    action: 'employee_support.ticket.replied',
    resource: TICKETS_TABLE,
    resource_id: ticketRow.id,
    details: {
      ticket_no: ticketRow.ticket_no,
      work_email: ticketRow.work_email,
      message_id: message.id,
      flagged: flagReason !== null,
      flag_reason: flagReason,
      // The row forgets it was ever closed once reopened; this is where it is remembered.
      reopened,
      ...(reopenError ? { reopen_error: reopenError } : {}),
      on_behalf: authz.sessionEmail !== authz.effectiveEmail,
    },
  });

  // A reopen changes the ticket's place on the staff board; a plain reply
  // changes only the thread. Every listener re-fetches either way.
  announce(ticketRow.id, reopened ? 'ticket' : 'message');
  void notifyEmployeeReplied({ ticket: ticketRow, body: text, reopened });

  // The whole thread back, so the UI does not need a second round trip to show
  // what was just said. `null` — never `[]` — if the re-read failed.
  const thread = await readThread(sb, ticketRow.id);
  const messages = thread.migrated && !thread.error ? thread.rows : null;

  return NextResponse.json({
    migrated: true,
    ticket: toWire(ticketRow, messages ? summarize(messages) : null),
    message,
    messages,
    reopened,
    error: null,
  });
}
