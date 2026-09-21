import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { deniedResponse, type AuthzOk } from '@/lib/auth/authorize-email';
import { requireFeatureAccessAnyView } from '@/lib/auth/authorize-feature';
import { auditFrom } from '@/lib/audit/context';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { classifyColumnProbe, classifyTableProbe } from '@/lib/db/probe-verdict';
import { normEmail } from '@/lib/email/norm-email';
import { lookupFullNameForEmail } from '@/lib/supabase/announcements';
import { broadcastFromServer } from '@/lib/supabase/realtime-broadcast';
import { resolveWebhookUrl } from '@/lib/webhooks/resolve-webhook';
import { recordNotifyFailure } from '@/lib/notifications/notify-failure-audit';
import { TICKET_LIVE_EVENT, TICKET_LIVE_TOPIC, type TicketLivePayload } from '@/lib/support/ticket-live';
import { screenText } from '@/lib/support/screening';
import { staffReplyRecipient } from '@/lib/support/recipients';
import { canStaffAct, nextStatus, type Actor, type LifecycleTicket } from '@/lib/support/lifecycle';
import { isSupportPriority, stageOf, type SupportPriority, type TicketStage } from '@/lib/support/triage';
import {
  SUPPORT_CONCERN_MAX,
  formatSupportTicketNo,
  needsStaffReply,
  type SupportStatus,
} from '@/lib/support/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Employee Support — the STAFF side of one ticket's thread.
 *
 * Plan: docs/superpowers/plans/2026-09-21-employee-support-tickets-board.md
 * (task 7). Tables: `employee_support_tickets` + `employee_support_messages`,
 * the same two `../route.ts` requires, for the same reason.
 *
 *   GET   → { migrated, ticket, messages }  the whole thread, oldest first,
 *           WITH the flag columns — a flag is a note to whoever is about to
 *           reply, the same reason the chat agent projection carries it.
 *   POST  → { action: 'reply', body } | { action: 'close' } | { action: 'reopen' }
 *
 * GATED AT `view`, NOT `edit` — THE DOCUMENTED EXCEPTION
 * ---------------------------------------------------------------------------
 * `../route.ts`'s header names this file as the one place Employee Support
 * diverges from its own "every write needs edit" rule, following
 * `app/api/tickets/[id]/comments/route.ts:43-46`: a "view" grant on this
 * catalog can still answer a ticket, the same way a "View only" dev-board
 * member can still comment on their own. The catalog's `edit` bit stays about
 * the BOARD — claiming, ranking, handing off — where somebody was
 * deliberately held back from deciding who answers an employee's pay dispute.
 * Replying is not that decision; it is doing the work the grant exists for.
 *
 * `lifecycle.ts` STILL DECIDES WHO, EVEN THOUGH THE ROUTE ADMITS EVERYONE
 * ---------------------------------------------------------------------------
 * The feature gate is wide; `canStaffAct` is not. A `close` on a ticket
 * somebody else holds is refused by the verdict regardless of the caller's
 * feature grant — the same two-layer shape `../route.ts` uses, so a button
 * this file disables and a button that route disables come from one source.
 *
 * MESSAGE FIRST, THEN THE GUARDED STATUS UPDATE — NEVER THE OTHER ORDER
 * ---------------------------------------------------------------------------
 * Exactly the employee reply route's reasoning, reversed: if the ticket write
 * fails after the message is saved, the employee still has a real answer on
 * their thread and the next action retries the transition for free. The other
 * order can save a status flip and then lose the words that earned it.
 *
 * `first_response_at` IS STAMPED HERE, ONCE
 * ---------------------------------------------------------------------------
 * `needsStaffReply` reads it; the board's counts and the employee's one-day
 * promise are both measured against it. Stamped only when it was `null`
 * going in — a ticket answered Monday and replied to again Tuesday was still
 * first answered Monday.
 */

const TICKETS_TABLE = 'employee_support_tickets';
const MESSAGES_TABLE = 'employee_support_messages';

/** Same catalog key `../route.ts` uses — one feature key, two gate levels. */
const SUPPORT_TICKETS_FEATURE = 'support_tickets';

const NOT_FOUND = 'Ticket not found.';
const NOT_MIGRATED = 'Employee Support tickets are not switched on yet. Nothing was sent.';
const UNAVAILABLE = 'Employee Support is unavailable right now.';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every column a verdict or the wire needs. Matches `../route.ts`'s TICKET_SELECT. */
const TICKET_SELECT =
  'id, ticket_no, work_email, member_name, department, category, concern, status, priority, triaged_at, triaged_by, claimed_by, claimed_at, first_response_at, closed_by, closed_at, flagged_at, flag_reason, created_at, updated_at';

/** Wider than the employee's own projection: `author_email` and both flag columns. */
const MESSAGE_SELECT = 'id, author_side, author_email, author_name, body, flagged_at, flag_reason, created_at';

type TicketDbRow = {
  id: string;
  ticket_no: number;
  work_email: string;
  member_name: string | null;
  department: string | null;
  category: string;
  concern: string;
  status: SupportStatus;
  priority: string | null;
  triaged_at: string | null;
  triaged_by: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  first_response_at: string | null;
  closed_by: string | null;
  closed_at: string | null;
  flagged_at: string | null;
  flag_reason: string | null;
  created_at: string;
  updated_at: string;
};

type MessageWire = {
  id: string;
  author_side: 'employee' | 'staff';
  author_email: string | null;
  author_name: string | null;
  body: string;
  flagged_at: string | null;
  flag_reason: string | null;
  created_at: string;
};

/** Same shape as `../route.ts`'s `SupportTicketWire`, so the board and this thread agree on one type. */
type SupportTicketWire = {
  id: string;
  ticket_no: number;
  label: string;
  work_email: string;
  member_name: string | null;
  department: string | null;
  category: string;
  concern: string;
  status: SupportStatus;
  priority: SupportPriority;
  stage: TicketStage;
  triaged_at: string | null;
  triaged_by: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  first_response_at: string | null;
  closed_by: string | null;
  closed_at: string | null;
  flagged_at: string | null;
  flag_reason: string | null;
  created_at: string;
  updated_at: string;
  needs_reply: boolean;
};

function toWire(row: TicketDbRow): SupportTicketWire {
  const priority: SupportPriority = isSupportPriority(row.priority) ? row.priority : null;
  const triage = { status: row.status, priority, created_at: row.created_at, first_response_at: row.first_response_at };
  return {
    ...triage,
    id: row.id,
    ticket_no: row.ticket_no,
    label: formatSupportTicketNo(row.ticket_no),
    work_email: row.work_email,
    member_name: row.member_name,
    department: row.department,
    category: row.category,
    concern: row.concern,
    stage: stageOf(triage),
    triaged_at: row.triaged_at,
    triaged_by: row.triaged_by,
    claimed_by: row.claimed_by,
    claimed_at: row.claimed_at,
    closed_by: row.closed_by,
    closed_at: row.closed_at,
    flagged_at: row.flagged_at,
    flag_reason: row.flag_reason,
    updated_at: row.updated_at,
    needs_reply: needsStaffReply(triage),
  };
}

function lifecycleOf(row: TicketDbRow): LifecycleTicket {
  return {
    status: row.status,
    priority: isSupportPriority(row.priority) ? row.priority : null,
    claimed_by: row.claimed_by,
  };
}

/* ─────────────────────────────── gate + reads ───────────────────────────── */

async function prepare(
  level: 'view' | 'edit',
): Promise<{ ok: true; authz: AuthzOk; sb: SupabaseClient } | { ok: false; response: NextResponse }> {
  const authz = await requireFeatureAccessAnyView(SUPPORT_TICKETS_FEATURE, level);
  if (!authz.ok) return { ok: false, response: deniedResponse(authz) };

  const sb = createSupabaseServiceRoleClient();
  if (!sb) {
    return { ok: false, response: NextResponse.json({ error: UNAVAILABLE }, { status: 503 }) };
  }
  return { ok: true, authz, sb };
}

function actorOf(authz: AuthzOk): Actor | null {
  const email = normEmail(authz.sessionEmail);
  if (!email) return null;
  return { email, isAdmin: authz.roles.includes('admin') };
}

type TicketLookupFailure = { reason: 'not_found' } | { reason: 'not_migrated' } | { reason: 'error'; message: string };

/** Any staff member may read any ticket — one global answer team, same as chat's one global queue. */
async function readTicket(
  sb: SupabaseClient,
  id: string,
): Promise<{ ok: true; row: TicketDbRow } | ({ ok: false } & TicketLookupFailure)> {
  if (!UUID_RE.test(id)) return { ok: false, reason: 'not_found' };

  const { data, error } = await sb.from(TICKETS_TABLE).select(TICKET_SELECT).eq('id', id).limit(1);
  if (error) {
    if (classifyColumnProbe(error) === 'MISSING') return { ok: false, reason: 'not_migrated' };
    return { ok: false, reason: 'error', message: error.message };
  }
  const row = (data?.[0] as TicketDbRow | undefined) ?? null;
  if (!row) return { ok: false, reason: 'not_found' };
  return { ok: true, row };
}

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
    if (classifyTableProbe({ message: error }) === 'MISSING') return { rows: [], error: null, migrated: false };
    return { rows: [], error, migrated: true };
  }
  return { rows, error: null, migrated: true };
}

/** See `src/lib/tickets/notify.ts`: a localhost NEXTAUTH_URL is a link nobody's inbox can open. */
function publicOrigin(): string {
  const raw = (process.env.NEXTAUTH_URL ?? '').trim().replace(/\/$/, '');
  if (!raw || /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|192\.168\.|10\.)/i.test(raw)) {
    return 'https://simple-hris.vercel.app';
  }
  return raw;
}

function announce(ticketId: string, kind: TicketLivePayload['kind']): void {
  void broadcastFromServer(TICKET_LIVE_TOPIC, TICKET_LIVE_EVENT, {
    ...({ kind, ticketId, ts: Date.now() } satisfies TicketLivePayload),
  });
}

/**
 * The n8n EMAIL leg for a staff reply. Same slug the employee's own reply uses
 * in the other direction (`app/api/employee/support/[id]/messages/route.ts`),
 * `recipient_is_employee` telling the workflow which way this one faces —
 * exactly the shape the dev board's single `ticket_replied` slug already uses.
 */
async function notifyTicketReplied(input: { ticket: TicketDbRow; repliedBy: string | null; body: string }): Promise<void> {
  try {
    const sendTo = staffReplyRecipient({ work_email: input.ticket.work_email, claimed_by: input.ticket.claimed_by });
    if (!sendTo) return;

    const url = await resolveWebhookUrl('support_replied', { envVars: ['N8N_SUPPORT_REPLIED_WEBHOOK_URL'] });
    if (!url) return;

    const origin = publicOrigin();
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'support.replied',
        send_to: sendTo,
        recipient_is_employee: true,
        ticket_no: input.ticket.ticket_no,
        label: formatSupportTicketNo(input.ticket.ticket_no),
        member_name: input.ticket.member_name ?? '',
        work_email: input.ticket.work_email,
        replied_by: input.repliedBy ?? sendTo,
        preview: `${input.body.slice(0, 140)}${input.body.length > 140 ? '…' : ''}`,
        replied_at: new Date().toISOString(),
        my_tickets_url: `${origin}/employee`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Best-effort only — the reply is already saved.
  }
}

/**
 * The in-app row Carla signed: "A notification the moment someone replies."
 * `support.answered` on the transition that stamps `first_response_at`;
 * `support.replied` on every later staff line. Both map to `['employee']`.
 */
async function notifyInApp(
  sb: SupabaseClient,
  request: Request,
  authz: AuthzOk,
  ticket: TicketDbRow,
  isFirstResponse: boolean,
  repliedBy: string | null,
): Promise<void> {
  const recipient = staffReplyRecipient({ work_email: ticket.work_email, claimed_by: ticket.claimed_by });
  if (!recipient) return;

  const type = isFirstResponse ? 'support.answered' : 'support.replied';
  const label = formatSupportTicketNo(ticket.ticket_no);
  const notif = await sb.from('employee_notifications').insert({
    recipient_email: recipient,
    type,
    tone: 'neutral',
    title: isFirstResponse ? 'Your ticket has been answered' : 'Support replied to your ticket',
    message: `${repliedBy ?? 'Support'} replied on your ticket ${label}.`,
    details: { ticket_id: ticket.id, ticket_no: ticket.ticket_no },
  });
  if (notif.error) {
    void recordNotifyFailure({
      notificationType: type,
      origin: 'support/tickets/[id]/reply',
      error: notif.error,
      actor: { user_name: authz.sessionEmail, user_role: authz.roles[0] ?? 'user' },
      details: { ticket_no: ticket.ticket_no },
    });
  }
}

/* ──────────────────────────────── GET ───────────────────────────────────── */

/** GET — the ticket and its whole thread, flags included. Any staff member may read any ticket. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const prepared = await prepare('view');
  if (!prepared.ok) return prepared.response;
  const { sb } = prepared;

  const found = await readTicket(sb, id);
  if (!found.ok) {
    if (found.reason === 'not_migrated') {
      return NextResponse.json({ migrated: false, ticket: null, messages: [], error: null });
    }
    if (found.reason === 'error') {
      return NextResponse.json({ migrated: true, ticket: null, messages: [], error: found.message }, { status: 500 });
    }
    return NextResponse.json({ ticket: null, messages: [], error: NOT_FOUND }, { status: 404 });
  }

  const thread = await readThread(sb, found.row.id);
  if (!thread.migrated) {
    return NextResponse.json({ migrated: false, ticket: null, messages: [], error: null });
  }
  if (thread.error) {
    return NextResponse.json(
      { migrated: true, ticket: toWire(found.row), messages: [], error: thread.error },
      { status: 500 },
    );
  }

  return NextResponse.json({ migrated: true, ticket: toWire(found.row), messages: thread.rows, error: null });
}

/* ──────────────────────────────── POST ──────────────────────────────────── */

type PostBody = { action?: unknown; body?: unknown };
const ACTS = ['reply', 'close', 'reopen'] as const;
type ThreadAct = (typeof ACTS)[number];
const isThreadAct = (v: unknown): v is ThreadAct => typeof v === 'string' && (ACTS as readonly string[]).includes(v);

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  let body: PostBody;
  try {
    body = ((await request.json()) as PostBody) ?? {};
  } catch {
    return NextResponse.json({ ticket: null, message: null, messages: null, error: 'Invalid request body' }, { status: 400 });
  }

  const prepared = await prepare('view');
  if (!prepared.ok) return prepared.response;
  const { authz, sb } = prepared;

  const actor = actorOf(authz);
  if (!actor) return NextResponse.json({ ticket: null, message: null, messages: null, error: 'Not signed in' }, { status: 401 });

  if (!isThreadAct(body.action)) {
    return NextResponse.json(
      { ticket: null, message: null, messages: null, error: "Unknown action. Use 'reply', 'close' or 'reopen'." },
      { status: 400 },
    );
  }
  // Captured into its own const rather than re-reading `body.action` after the
  // `await` below — a property narrowing is not guaranteed to survive an
  // intervening async call.
  const act: ThreadAct = body.action;
  const replyText = body.body;

  const found = await readTicket(sb, id);
  if (!found.ok) {
    if (found.reason === 'not_migrated') {
      return NextResponse.json({ migrated: false, ticket: null, message: null, messages: null, error: NOT_MIGRATED }, { status: 503 });
    }
    if (found.reason === 'error') {
      return NextResponse.json({ migrated: true, ticket: null, message: null, messages: null, error: found.message }, { status: 500 });
    }
    return NextResponse.json({ ticket: null, message: null, messages: null, error: NOT_FOUND }, { status: 404 });
  }

  if (act === 'close') return closeTicket(sb, request, authz, actor, found.row);
  if (act === 'reopen') return reopenTicket(sb, request, authz, actor, found.row);
  return reply(sb, request, authz, actor, found.row, replyText);
}

/**
 * CLOSE. `canStaffAct` refuses over the caller's head — the holder or an
 * admin, or anybody at all when nobody holds it. The compare-and-set repeats
 * whichever half of that the verdict was formed from.
 */
async function closeTicket(sb: SupabaseClient, request: Request, authz: AuthzOk, actor: Actor, row: TicketDbRow) {
  const before = lifecycleOf(row);
  const verdict = canStaffAct('close', before, actor);
  if (!verdict.allowed) {
    return NextResponse.json(
      { migrated: true, ticket: toWire(row), message: null, messages: null, error: `${verdict.reason} Nothing was changed.` },
      { status: 409 },
    );
  }

  let update = sb
    .from(TICKETS_TABLE)
    .update({ status: 'closed', closed_by: actor.email, closed_at: new Date().toISOString() })
    .eq('id', row.id)
    .neq('status', 'closed');
  update = row.claimed_by === null ? update.is('claimed_by', null) : update.eq('claimed_by', row.claimed_by);

  const result = await update.select(TICKET_SELECT);
  if (result.error) {
    return NextResponse.json({ migrated: true, ticket: toWire(row), message: null, messages: null, error: result.error.message }, { status: 500 });
  }
  const after = (result.data?.[0] as TicketDbRow | undefined) ?? null;
  if (!after) {
    return NextResponse.json(
      { migrated: true, ticket: toWire(row), message: null, messages: null, error: 'Somebody else changed this ticket first. Nothing was recorded — refresh.' },
      { status: 409 },
    );
  }

  void insertAuditLog({
    ...auditFrom(request, authz),
    action: 'employee_support.ticket.closed',
    resource: TICKETS_TABLE,
    resource_id: row.id,
    details: { ticket_no: row.ticket_no, work_email: row.work_email },
  });
  announce(row.id, 'ticket');

  return NextResponse.json({ migrated: true, ticket: toWire(after), message: null, messages: null, error: null });
}

/** REOPEN. `closed_by`/`closed_at` survive — the row keeps its history, the SQL already allows it. */
async function reopenTicket(sb: SupabaseClient, request: Request, authz: AuthzOk, actor: Actor, row: TicketDbRow) {
  const before = lifecycleOf(row);
  const verdict = canStaffAct('reopen', before, actor);
  if (!verdict.allowed) {
    return NextResponse.json(
      { migrated: true, ticket: toWire(row), message: null, messages: null, error: `${verdict.reason} Nothing was changed.` },
      { status: 409 },
    );
  }

  const result = await sb
    .from(TICKETS_TABLE)
    .update({ status: 'open' })
    .eq('id', row.id)
    .eq('status', 'closed')
    .select(TICKET_SELECT);
  if (result.error) {
    return NextResponse.json({ migrated: true, ticket: toWire(row), message: null, messages: null, error: result.error.message }, { status: 500 });
  }
  const after = (result.data?.[0] as TicketDbRow | undefined) ?? null;
  if (!after) {
    return NextResponse.json(
      { migrated: true, ticket: toWire(row), message: null, messages: null, error: 'It was already reopened. Nothing was changed — refresh.' },
      { status: 409 },
    );
  }

  void insertAuditLog({
    ...auditFrom(request, authz),
    action: 'employee_support.ticket.reopened',
    resource: TICKETS_TABLE,
    resource_id: row.id,
    details: { ticket_no: row.ticket_no, work_email: row.work_email },
  });
  announce(row.id, 'ticket');

  return NextResponse.json({ migrated: true, ticket: toWire(after), message: null, messages: null, error: null });
}

/**
 * REPLY. A staff reply to a CLOSED ticket does not reopen it — `lifecycle.ts`
 * owns the asymmetry and argues it; this route only enforces the verdict.
 */
async function reply(sb: SupabaseClient, request: Request, authz: AuthzOk, actor: Actor, row: TicketDbRow, rawBody: unknown) {
  const text = typeof rawBody === 'string' ? rawBody.trim() : '';
  if (!text) {
    return NextResponse.json({ migrated: true, ticket: toWire(row), message: null, messages: null, error: 'Type a reply to send.' }, { status: 400 });
  }
  if (text.length > SUPPORT_CONCERN_MAX) {
    return NextResponse.json(
      { migrated: true, ticket: toWire(row), message: null, messages: null, error: `That reply is too long (max ${SUPPORT_CONCERN_MAX} characters). Nothing was sent.` },
      { status: 400 },
    );
  }

  const before = lifecycleOf(row);
  const verdict = canStaffAct('reply', before, actor);
  if (!verdict.allowed) {
    return NextResponse.json(
      { migrated: true, ticket: toWire(row), message: null, messages: null, error: `${verdict.reason} Nothing was sent.` },
      { status: 409 },
    );
  }

  const staffName = await lookupFullNameForEmail(authz.sessionEmail);

  // Screening records; it never refuses — the same rule on both sides of the desk.
  const screening = screenText(text);
  const flagReason = screening.flagged ? screening.reason : null;
  const flaggedAt = flagReason ? new Date().toISOString() : null;

  const inserted = await sb
    .from(MESSAGES_TABLE)
    .insert({
      ticket_id: row.id,
      author_side: 'staff',
      author_email: actor.email,
      author_name: staffName,
      body: text,
      flagged_at: flaggedAt,
      flag_reason: flagReason,
    })
    .select(MESSAGE_SELECT)
    .limit(1);

  if (inserted.error) {
    if (classifyTableProbe(inserted.error) === 'MISSING') {
      return NextResponse.json({ migrated: false, ticket: null, message: null, messages: null, error: NOT_MIGRATED }, { status: 503 });
    }
    return NextResponse.json({ migrated: true, ticket: toWire(row), message: null, messages: null, error: inserted.error.message }, { status: 500 });
  }
  const message = (inserted.data?.[0] as MessageWire | undefined) ?? null;
  if (!message) {
    return NextResponse.json(
      { migrated: true, ticket: toWire(row), message: null, messages: null, error: 'The reply was not saved. Please try again.' },
      { status: 500 },
    );
  }

  // THE TICKET UPDATE, best-effort behind the already-saved message. Auto-claim
  // (Kane's "whoever touches it first") is a compare-and-set on NULL; the
  // status move is `nextStatus('reply', …, 'staff')`; `first_response_at` is
  // stamped only when it was null going in.
  const nowIso = new Date().toISOString();
  const isFirstResponse = row.first_response_at === null;
  const to = nextStatus('reply', before, 'staff');
  const patch: Record<string, unknown> = {};
  if (verdict.claims) {
    patch.claimed_by = actor.email;
    patch.claimed_at = nowIso;
  }
  if (to !== null) patch.status = to;
  if (isFirstResponse) patch.first_response_at = nowIso;

  let ticketRow = row;
  let updateError: string | null = null;
  if (Object.keys(patch).length > 0) {
    let update = sb.from(TICKETS_TABLE).update(patch).eq('id', row.id);
    // The condition the verdict was formed from, repeated in the WHERE: an
    // auto-claim is a CAS on NULL; otherwise the hold this decision was made
    // about must not have moved (mirrors `../route.ts`'s reassign guard).
    update = verdict.claims
      ? update.is('claimed_by', null)
      : row.claimed_by !== null
        ? update.eq('claimed_by', row.claimed_by)
        : update;
    const result = await update.select(TICKET_SELECT);
    if (result.error) {
      updateError = result.error.message;
    } else {
      const after = (result.data?.[0] as TicketDbRow | undefined) ?? null;
      if (after) {
        ticketRow = after;
      } else {
        // Lost the race — somebody else claimed or reassigned between the read
        // and this write. The reply stands; read the truth back.
        const again = await readTicket(sb, row.id);
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
      first_response: isFirstResponse,
      auto_claimed: verdict.claims,
      ...(updateError ? { update_error: updateError } : {}),
    },
  });

  announce(ticketRow.id, 'message');
  void notifyInApp(sb, request, authz, ticketRow, isFirstResponse, staffName ?? actor.email);
  void notifyTicketReplied({ ticket: ticketRow, repliedBy: staffName, body: text });

  const thread = await readThread(sb, ticketRow.id);
  const messages = thread.migrated && !thread.error ? thread.rows : null;

  return NextResponse.json({ migrated: true, ticket: toWire(ticketRow), message, messages, error: null });
}
