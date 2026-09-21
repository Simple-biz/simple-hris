import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authorizeEmailAccess, deniedResponse, type AuthzOk } from '@/lib/auth/authorize-email';
import { auditFrom } from '@/lib/audit/context';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { classifyColumnProbe, classifyTableProbe } from '@/lib/db/probe-verdict';
import { getEmployeeMasterRecord } from '@/lib/supabase/employees';
import { getAppSetting } from '@/lib/supabase/app-settings';
import { normEmail } from '@/lib/email/norm-email';
import { broadcastFromServer } from '@/lib/supabase/realtime-broadcast';
import { resolveWebhookUrl } from '@/lib/webhooks/resolve-webhook';
import { TICKET_LIVE_EVENT, TICKET_LIVE_TOPIC, type TicketLivePayload } from '@/lib/support/ticket-live';
import { screenText } from '@/lib/support/screening';
import { ticketFiledRecipient } from '@/lib/support/recipients';
import { isSupportOpen } from '@/lib/support/hours';
import {
  SUPPORT_CATEGORY_LABELS,
  SUPPORT_CONCERN_MAX,
  SUPPORT_REPLY_PROMISE,
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
 * Employee Support TICKETS — the employee's own questions, and the form that
 * files one.
 *
 * Plan: docs/superpowers/plans/2026-09-14-employee-support.md (task 8; the
 * track map is task 25). The Help chooser this sits behind is the 2026-09-21
 * ruling recorded in docs/superpowers/plans/2026-09-21-employee-support-tickets-board.md.
 * Tables: references/sql/create/2026-09-16_employee_support.sql plus
 * references/sql/alter/2026-09-21_employee_support_triage.sql — see MIGRATIONS.
 *
 *   GET  → { migrated, me, tickets, counts, latest_staff_reply_at, support }
 *          the caller's OWN tickets, newest first, each with a summary of its
 *          thread. `me` is who the server says they are, so the form's "name
 *          and work email fill in automatically" (Carla) is the server's
 *          answer and never the browser's guess.
 *   POST → { category, concern, email? }  file one. Answers with the ES-
 *          number and the promise — "within one working day" — as the two
 *          things Carla signed the employee is owed at filing.
 *
 * THE FOUR THINGS THIS FILE IS CAREFUL ABOUT
 * ---------------------------------------------------------------------------
 * 1. **`authz.effectiveEmail` is the identity; the body is only a request.**
 *    `authorizeEmailAccess` grants `?email=` / `body.email` only to the person
 *    themself or an elevated viewer, and `work_email` is then the MASTER
 *    address resolved server-side from that grant (`resolveIdentity`) — an
 *    employee can sign in with a personal or alternate address, and the address
 *    they arrived with is not necessarily who they are. Same shape as the chat
 *    route beside this one and as /api/resignation-requests.
 * 2. **Every set pages.** PostgREST caps a result set at 1000 rows with no
 *    error, even under `.range()`. A ticket list and a message list are sets,
 *    so both go through `selectAllPaged`.
 * 3. **A missing migration answers cleanly.** `migrated: false` on a read, 503
 *    on a write, never a 500 and never a silent pretend-save. `migrated` is
 *    present ONLY where the database was actually asked — a 401, a 403 or a
 *    "no client" 503 carries `{ error }` alone, because claiming the migration
 *    has not run when the truth is that we could not look would send the UI to
 *    the wrong sentence.
 * 4. **The screening flag never blocks, and the employee never sees it.**
 *    `screenText` records `flagged_at` / `flag_reason` and the ticket is filed
 *    regardless (screening.ts explains why a blocking screen silences the one
 *    person with a real complaint). Neither flag column is in the projection
 *    below: a flag is a note to the staffer, and handing it to the employee
 *    about their own words turns a reading aid into an accusation.
 *
 * "LAST LOOKED" — THE HONEST ANSWER
 * ---------------------------------------------------------------------------
 * The badge wants "unread staff replies since the employee last looked". The
 * server does NOT know when they last looked: there is no `last_read_at` on
 * either table, and this build adds no migration. So this route does not
 * pretend. What it can PROVE, it reports, per ticket in `thread` and in total:
 *
 *   `awaiting_you`          the last word on the thread is staff's — they said
 *                           something after anything the employee wrote. A
 *                           state, not a guess.
 *   `last_staff_reply_at`   when staff last spoke on that ticket, and the max
 *                           across all tickets as `latest_staff_reply_at`.
 *
 * `awaiting_you` clears when the employee replies. It does NOT clear by itself
 * on a CLOSED ticket — the only employee act on a closed ticket is a reply,
 * and that reopens it (lifecycle.ts). A badge that must clear on "I read it"
 * therefore owes a per-device seen stamp compared against
 * `latest_staff_reply_at`, which is the same conclusion `EmployeeSupportChat`
 * reached for its `needsAttention` dot: an unread marker can only live in the
 * browser, so the server hands over the facts and the browser holds the stamp.
 *
 * MIGRATIONS — THE EMPLOYEE SIDE REQUIRES THE SAME TWO AS THE STAFF BOARD
 * ---------------------------------------------------------------------------
 * `TICKET_SELECT` names `priority`, which the triage ALTER adds. That is
 * deliberate coupling and not laziness: the reply route beside this one needs
 * it to build a `LifecycleTicket`, the two employee routes must agree about
 * `migrated`, and a ticket the staff board cannot show is a ticket filed into
 * the void — better to say "not switched on yet" than to accept a question
 * nobody can see. `classifyColumnProbe` reads a missing table and a missing
 * column as the same MISSING, so both halves answer the same way.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 * * **No per-day cap.** Carla's Decision 6. Do not add one.
 * * **No attachments.** Decision 8.
 * * **No status on the insert.** `status` defaults to `open`; the employee
 *   side never moves a ticket except by the reopen-on-reply rule, which lives
 *   in `[id]/messages/route.ts`.
 * * **No hours gate.** `hours.ts`: a question filed at 2 AM is answered at 9 AM
 *   and that beats making somebody remember to come back. `support.open` is
 *   reported so the form can SAY the window; it never refuses on it.
 * * **No `claimed_by`, `priority`, `flagged_at` or `filed_by_email` on the
 *   wire.** A staffer's address is not the employee's to have (their name
 *   arrives through `author_name` on the thread), triage is the board's
 *   business, the flag is a staff note, and the employee knows how they got
 *   here.
 * * **No in-app notification on filing.** `recipients.ts`: a filed ticket goes
 *   to the configured support INBOX by email, if one is configured, and the
 *   staff board's own line is the cheap channel. Five inboxes is the expensive
 *   one.
 *
 * REALTIME — A SIGNAL, NEVER CONTENT
 * ---------------------------------------------------------------------------
 * A ticket id and a kind go on the topic; nothing else. The browser client is
 * anon and there is no private channel in this repo, so anything on the topic
 * is readable by any anon-key holder — the defect `chat-live.ts` documents.
 * Every listener re-fetches through its own gated route. The topic constants
 * live in `src/lib/support/ticket-live.ts`, shared with `[id]/messages/route.ts`
 * and the staff board (`app/api/support/tickets/[id]/reply/route.ts`).
 */

const TICKETS_TABLE = 'employee_support_tickets';
const MESSAGES_TABLE = 'employee_support_messages';

/**
 * Where a "new ticket" email goes. `recipients.ts` says this is configuration —
 * a shared inbox the five already watch, never a person chosen in code — so it
 * is an `app_settings` key with an env fallback, and `null` when neither is
 * set. Silence here is a missing setting, never a lost ticket.
 */
const SUPPORT_INBOX_SETTING = 'employee_support.inbox';
const SUPPORT_INBOX_ENV = 'EMPLOYEE_SUPPORT_INBOX';

const NOT_MIGRATED = 'Employee Support tickets are not switched on yet. Nothing was saved.';
const UNAVAILABLE = 'Employee Support is unavailable right now.';

/**
 * Ticket ids per `.in()` when reading threads. Fifty uuids is under two
 * kilobytes of query string; the whole set is still walked, one chunk at a
 * time, each chunk paged.
 */
const IN_CHUNK = 50;

/**
 * Every column this side reads, once. `work_email` is here for the ownership
 * filter and `claimed_by` for the reply route's recipient decision; neither
 * reaches the wire — {@link toWire} is the only projection. ONE string
 * literal, never a concatenation, for the reason the staff route gives: the
 * client parses it and a column left out is a compile error, not an
 * `undefined` that reads as a fact.
 */
const TICKET_SELECT =
  'id, ticket_no, work_email, member_name, category, concern, status, priority, claimed_by, claimed_at, first_response_at, closed_at, created_at, updated_at';

type TicketDbRow = {
  id: string;
  ticket_no: number;
  work_email: string;
  member_name: string | null;
  category: string;
  concern: string;
  /** CHECK-backed since the table shipped (`2026-09-16_employee_support.sql:85-87`). */
  status: SupportStatus;
  /** Raw off the wire; the reply route narrows it. Named here so a missing ALTER is a clean MISSING. */
  priority: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  first_response_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
};

/** What the server can prove about one thread. See "LAST LOOKED" in the header. */
type ThreadSummary = {
  /** Replies on the thread. The ticket's own `concern` is not counted — it is the ticket. */
  messages: number;
  staff_replies: number;
  last_message_at: string | null;
  last_message_side: SupportAuthorSide | null;
  last_staff_reply_at: string | null;
  /** The last word is staff's. A state, not an unread count. */
  awaiting_you: boolean;
};

/** The employee-facing projection. No addresses but their own, no flags, no triage. */
type EmployeeTicketWire = {
  id: string;
  ticket_no: number;
  /** `ES-1043`, from the one formatter, so this and the staff row read one string. */
  label: string;
  category: string;
  category_label: string;
  concern: string;
  status: SupportStatus;
  /** Waiting / Being looked at / Answered / Closed — the track stops (Kane, 2026-09-18). */
  status_label: string;
  created_at: string;
  updated_at: string;
  /** The three stop timestamps. Times, never the addresses that set them. */
  claimed_at: string | null;
  first_response_at: string | null;
  closed_at: string | null;
  /** `needsStaffReply`, so the row and the staff count cannot disagree about it. */
  needs_staff_reply: boolean;
  /** `null` means the thread read FAILED — unknown, never "no replies". */
  thread: ThreadSummary | null;
};

/** `null` anywhere means WE COULD NOT TELL. `resolved: false` owes a skeleton, never a 0. */
type EmployeeCounts = {
  total: number | null;
  /** Anything not closed. */
  open: number | null;
  /** Tickets where the last word is staff's. */
  awaiting_you: number | null;
  resolved: boolean;
};

const COUNTS_UNRESOLVED: Readonly<EmployeeCounts> = Object.freeze({
  total: null,
  open: null,
  awaiting_you: null,
  resolved: false,
});

/**
 * Who the caller is, resolved SERVER-SIDE from the master list.
 *
 * `work_email` is the key every other surface joins on and the one the
 * "my tickets" index is built over, so GET and POST — and the reply route —
 * must all resolve it the same way or they will disagree about which tickets
 * are the caller's.
 */
type Identity = {
  work_email: string;
  member_name: string | null;
  department: string | null;
};

/**
 * Resolve identity, or refuse.
 *
 * A master-list READ FAILURE is not the same as an employee with no master row.
 * The second is legitimate (internal devs and founders fall off the sheet) and
 * falls back to the signed-in address. The first would key the ticket on the
 * WRONG email — filed under an address the GET then never looks up, so the
 * employee's own question vanishes from their own list. A read failure stops
 * the request instead of guessing. Copied from the chat route, deliberately.
 */
async function resolveIdentity(
  effectiveEmail: string,
): Promise<{ identity: Identity | null; error: string | null }> {
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

/** Everything a caller needs before touching the tables: a gate, a client, an identity. */
async function prepare(
  requestedEmail: string | null,
): Promise<
  | { ok: true; authz: AuthzOk; sb: SupabaseClient; identity: Identity }
  | { ok: false; response: NextResponse }
> {
  const authz = await authorizeEmailAccess(requestedEmail);
  if (!authz.ok) return { ok: false, response: deniedResponse(authz) };

  // NOTE WHAT IS ABSENT FROM THESE TWO BODIES: `migrated`. Neither failure has
  // asked the database anything, so neither may claim an answer about whether
  // the migration ran. Same rule as the chat route.
  const sb = createSupabaseServiceRoleClient();
  if (!sb) {
    return { ok: false, response: NextResponse.json({ error: UNAVAILABLE }, { status: 503 }) };
  }

  const { identity, error } = await resolveIdentity(authz.effectiveEmail);
  if (!identity) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: error ?? 'We could not confirm who you are just now. Try again in a moment.' },
        { status: 503 },
      ),
    };
  }
  return { ok: true, authz, sb, identity };
}

/* ─────────────────────────────── reads ──────────────────────────────────── */

type ReadResult = { rows: TicketDbRow[]; error: string | null; migrated: boolean };

/**
 * A missing TABLE and a missing `priority` COLUMN are the same answer to the
 * caller — the migrations have not run — and `classifyColumnProbe` covers both.
 */
function settle(rows: TicketDbRow[], error: string | null): ReadResult {
  if (error) {
    if (classifyColumnProbe({ message: error }) === 'MISSING') {
      return { rows: [], error: null, migrated: false };
    }
    return { rows: [], error, migrated: true };
  }
  return { rows, error: null, migrated: true };
}

/**
 * The caller's tickets, newest first. Paged: a set, however small it usually
 * is. Matching on `work_email` rather than `lower(work_email)` is safe because
 * the normalising trigger lowercases the column on write, and `identity.work_email`
 * is already lowercased by `normEmail`; the expression index is the read path's
 * backstop, not a second spelling of the key.
 */
async function readOwnTickets(sb: SupabaseClient, workEmail: string): Promise<ReadResult> {
  const { rows, error } = await selectAllPaged<TicketDbRow>((from, to) =>
    sb
      .from(TICKETS_TABLE)
      .select(TICKET_SELECT)
      .eq('work_email', workEmail)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to),
  );
  return settle(rows, error);
}

/**
 * Is the table there, with the columns this side reads? Scoped to the caller's
 * own key so it rides the "my tickets" index; a plain `.select(...).limit(1)`
 * and NEVER `head: true`, which answers "no error" for a table that does not
 * exist (probe-verdict.ts, in capitals).
 */
async function probeTickets(
  sb: SupabaseClient,
  workEmail: string,
): Promise<{ migrated: boolean; error: string | null }> {
  const { error } = await sb.from(TICKETS_TABLE).select(TICKET_SELECT).eq('work_email', workEmail).limit(1);
  if (!error) return { migrated: true, error: null };
  if (classifyColumnProbe(error) === 'MISSING') return { migrated: false, error: null };
  return { migrated: true, error: error.message };
}

type StampRow = { ticket_id: string; author_side: SupportAuthorSide; created_at: string };

const emptyThread = (): ThreadSummary => ({
  messages: 0,
  staff_replies: 0,
  last_message_at: null,
  last_message_side: null,
  last_staff_reply_at: null,
  awaiting_you: false,
});

/**
 * Fold one message stamp into its ticket's summary. Rows arrive in
 * `(created_at, id)` order from the server, and a ticket's messages all live
 * in the same chunk (chunks are by ticket id), so "the last one seen" IS the
 * latest — no re-sort, no `Date.parse`, no tie to break.
 */
function fold(summary: ThreadSummary, row: StampRow): void {
  summary.messages += 1;
  summary.last_message_at = row.created_at;
  summary.last_message_side = row.author_side;
  if (row.author_side === 'staff') {
    summary.staff_replies += 1;
    summary.last_staff_reply_at = row.created_at;
  }
  summary.awaiting_you = summary.last_message_side === 'staff';
}

/**
 * One summary per ticket, from `ticket_id, author_side, created_at` alone — no
 * bodies cross this read. Chunked `.in()`, each chunk paged.
 *
 * A ticket with no replies gets an EMPTY summary, which is a fact. `byTicket:
 * null` is the one failure answer and it means "we could not tell" — the caller
 * puts `thread: null` on every ticket and leaves the counts unresolved rather
 * than reporting zero replies to somebody who was answered yesterday.
 */
async function readThreadSummaries(
  sb: SupabaseClient,
  ticketIds: readonly string[],
): Promise<{ byTicket: Map<string, ThreadSummary> | null; error: string | null; migrated: boolean }> {
  const byTicket = new Map<string, ThreadSummary>();
  for (const id of ticketIds) byTicket.set(id, emptyThread());

  for (let i = 0; i < ticketIds.length; i += IN_CHUNK) {
    const chunk = ticketIds.slice(i, i + IN_CHUNK);
    const { rows, error } = await selectAllPaged<StampRow>((from, to) =>
      sb
        .from(MESSAGES_TABLE)
        .select('ticket_id, author_side, created_at')
        .in('ticket_id', chunk)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    );
    if (error) {
      // The two tables ship in one file, so a present tickets table with an
      // absent messages table is a half-applied migration — still "not
      // migrated", never an empty thread presented as the truth.
      if (classifyTableProbe({ message: error }) === 'MISSING') {
        return { byTicket: null, error: null, migrated: false };
      }
      return { byTicket: null, error, migrated: true };
    }
    for (const row of rows) {
      const summary = byTicket.get(row.ticket_id);
      if (summary) fold(summary, row);
    }
  }
  return { byTicket, error: null, migrated: true };
}

/* ─────────────────────────────── shapes ─────────────────────────────────── */

function toWire(row: TicketDbRow, thread: ThreadSummary | null): EmployeeTicketWire {
  return {
    id: row.id,
    ticket_no: row.ticket_no,
    label: formatSupportTicketNo(row.ticket_no),
    category: row.category,
    // Narrowed, not asserted: the CHECK admits only the nine, so the fallback
    // is belt and braces — a raw key is still better than a crash on a row.
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

/** The badge's numbers. Unresolved when any thread is unknown — a partial count is a wrong count. */
function countsOf(tickets: readonly EmployeeTicketWire[], threadsResolved: boolean): EmployeeCounts {
  const total = tickets.length;
  const open = tickets.filter((t) => t.status !== 'closed').length;
  if (!threadsResolved) return { total, open, awaiting_you: null, resolved: false };
  return {
    total,
    open,
    awaiting_you: tickets.filter((t) => t.thread?.awaiting_you === true).length,
    resolved: true,
  };
}

/** The most recent `last_staff_reply_at` across the set, or null. String compare is safe: ISO stamps, same zone. */
function latestStaffReplyAt(tickets: readonly EmployeeTicketWire[]): string | null {
  let latest: string | null = null;
  for (const t of tickets) {
    const at = t.thread?.last_staff_reply_at ?? null;
    if (at && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

/** THE FACT that a ticket moved. No body, no email, no concern — see the header. */
function announce(ticketId: string, kind: TicketLivePayload['kind']): void {
  // Spread into a fresh literal: `broadcastFromServer` takes a
  // `Record<string, unknown>` and a declared type alias carries no index
  // signature. `satisfies` keeps the payload checked against the contract.
  void broadcastFromServer(TICKET_LIVE_TOPIC, TICKET_LIVE_EVENT, {
    ...({ kind, ticketId, ts: Date.now() } satisfies TicketLivePayload),
  });
}

/**
 * Origin for links inside the email. NEXTAUTH_URL is localhost during dev — a
 * link nobody's inbox can open — so anything non-public falls back to the
 * production origin. The same function `src/lib/tickets/notify.ts` keeps.
 */
function publicOrigin(): string {
  const raw = (process.env.NEXTAUTH_URL ?? '').trim().replace(/\/$/, '');
  if (!raw || /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|192\.168\.|10\.)/i.test(raw)) {
    return 'https://simple-hris.vercel.app';
  }
  return raw;
}

/**
 * The n8n EMAIL leg for a newly filed ticket. Slug `support_filed` (plan
 * deploy notes), env fallback `N8N_SUPPORT_FILED_WEBHOOK_URL`.
 *
 * **The recipient is decided in code and handed over as `send_to`; the Gmail
 * node never picks one.** `ticketFiledRecipient` returns the configured inbox
 * or `null` — never `''`, because n8n's Gmail node is stop-on-error and an
 * empty To fails the whole run (the orientation-email Invalid-To incident,
 * docs/features/tickets-board.md:109-112). Returns early on null, no-op when no
 * webhook is configured, never throws — the ticket is already saved and the
 * caller `void`s this.
 *
 * A PREVIEW, not the concern. The email is a nudge to open the board; posting
 * a pay dispute's full text into an inbox is a second copy of HR-grade content
 * living somewhere nobody gated.
 */
async function notifyTicketFiled(row: TicketDbRow): Promise<void> {
  try {
    const configured = (await getAppSetting(SUPPORT_INBOX_SETTING)) ?? process.env[SUPPORT_INBOX_ENV] ?? null;
    const sendTo = ticketFiledRecipient(configured);
    if (!sendTo) return;

    const url = await resolveWebhookUrl('support_filed', {
      envVars: ['N8N_SUPPORT_FILED_WEBHOOK_URL'],
    });
    if (!url) return;

    const origin = publicOrigin();
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'support.filed',
        send_to: sendTo,
        ticket_no: row.ticket_no,
        label: formatSupportTicketNo(row.ticket_no),
        category: row.category,
        category_label: isSupportCategory(row.category) ? SUPPORT_CATEGORY_LABELS[row.category] : row.category,
        // The board shows name and work email on every row (Carla: "showing
        // name, work email, the concern and the ticket number"); the inbox that
        // watches the board may know the same two things.
        member_name: row.member_name ?? '',
        work_email: row.work_email,
        preview: `${row.concern.slice(0, 140)}${row.concern.length > 140 ? '…' : ''}`,
        filed_at: row.created_at,
        board_url: `${origin}/tickets`,
      }),
      // Bound the call so a slow or unreachable n8n cannot hang the filing.
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Best-effort only — the ticket is already saved.
  }
}

/* ──────────────────────────────── GET ───────────────────────────────────── */

/**
 * GET — the caller's own tickets, newest first, with what the server can
 * prove about each thread.
 *
 * `?email=` is a REQUEST that `authorizeEmailAccess` grants only to the person
 * themself or to an elevated viewer. A thread read that fails leaves the
 * tickets TRUE and the threads UNKNOWN (`thread: null`, `counts.resolved:
 * false`) rather than failing the list — the employee's questions exist
 * whether or not we could count their replies just now.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const prepared = await prepare(searchParams.get('email'));
  if (!prepared.ok) return prepared.response;
  const { sb, identity } = prepared;

  const now = new Date();
  const support = { open: isSupportOpen(now), promise: SUPPORT_REPLY_PROMISE };
  const me = { work_email: identity.work_email, member_name: identity.member_name };

  const own = await readOwnTickets(sb, identity.work_email);
  if (!own.migrated) {
    return NextResponse.json({
      migrated: false,
      me,
      tickets: [],
      counts: { ...COUNTS_UNRESOLVED },
      latest_staff_reply_at: null,
      support,
      error: null,
    });
  }
  if (own.error) {
    return NextResponse.json(
      {
        migrated: true,
        me,
        tickets: [],
        counts: { ...COUNTS_UNRESOLVED },
        latest_staff_reply_at: null,
        support,
        error: own.error,
      },
      { status: 500 },
    );
  }

  const threads = await readThreadSummaries(sb, own.rows.map((r) => r.id));
  if (!threads.migrated) {
    return NextResponse.json({
      migrated: false,
      me,
      tickets: [],
      counts: { ...COUNTS_UNRESOLVED },
      latest_staff_reply_at: null,
      support,
      error: null,
    });
  }

  const tickets = own.rows.map((r) => toWire(r, threads.byTicket?.get(r.id) ?? null));
  const resolved = threads.byTicket !== null;

  return NextResponse.json({
    migrated: true,
    me,
    tickets,
    counts: countsOf(tickets, resolved),
    latest_staff_reply_at: resolved ? latestStaffReplyAt(tickets) : null,
    support,
    error: null,
  });
}

/* ──────────────────────────────── POST ──────────────────────────────────── */

type FileBody = { category?: unknown; concern?: unknown; email?: unknown };

/**
 * POST — file a ticket.
 *
 * Carla's short form: what it is about (`category`, one of the nine) and what
 * happened (`concern`). Name and work email are NOT in the body — they are
 * resolved from the session (`resolveIdentity`) and written from there, so the
 * form cannot file as somebody else by editing a field.
 *
 * The bound is `SUPPORT_CONCERN_MAX`, refused HERE with a sentence so the DB's
 * 4000 CHECK is the backstop and not the validator. The concern is stored
 * TRIMMED, which is what the `..._concern_present` CHECK measures too.
 *
 * Note what is NOT written: `status`. Its default owns it, so this route cannot
 * start a ticket anywhere but `open`. And nothing here counts today's tickets —
 * Decision 6, no per-day cap.
 */
export async function POST(request: Request) {
  let body: FileBody;
  try {
    body = ((await request.json()) as FileBody) ?? {};
  } catch {
    return NextResponse.json({ ticket: null, error: 'Invalid request body' }, { status: 400 });
  }

  const prepared = await prepare(typeof body.email === 'string' ? body.email : null);
  if (!prepared.ok) return prepared.response;
  const { authz, sb, identity } = prepared;

  // Validation BEFORE the probe: a malformed form is a 400 whether or not the
  // migration ran, and neither answer below claims `migrated`.
  if (!isSupportCategory(body.category)) {
    return NextResponse.json({ ticket: null, error: 'Choose what this is about.' }, { status: 400 });
  }
  const concern = typeof body.concern === 'string' ? body.concern.trim() : '';
  if (!concern) {
    return NextResponse.json(
      { ticket: null, error: 'Tell us what happened — the message is empty.' },
      { status: 400 },
    );
  }
  if (concern.length > SUPPORT_CONCERN_MAX) {
    return NextResponse.json(
      {
        ticket: null,
        error: `That is too long (max ${SUPPORT_CONCERN_MAX} characters). Nothing was saved.`,
      },
      { status: 400 },
    );
  }

  const probe = await probeTickets(sb, identity.work_email);
  if (!probe.migrated) {
    return NextResponse.json({ migrated: false, ticket: null, error: NOT_MIGRATED }, { status: 503 });
  }
  if (probe.error) {
    return NextResponse.json({ migrated: true, ticket: null, error: probe.error }, { status: 500 });
  }

  // Screening records; it never refuses. Both flag columns derive from the ONE
  // verdict so the `..._flag_both_or_neither` CHECK holds by construction.
  const verdict = screenText(concern);
  const flagReason = verdict.flagged ? verdict.reason : null;
  const flaggedAt = flagReason ? new Date().toISOString() : null;

  const { data, error } = await sb
    .from(TICKETS_TABLE)
    .insert({
      // The identity is the answer; the body was only ever a request.
      work_email: identity.work_email,
      // "The address the session actually carried" — the column's stated
      // purpose (SQL :47-52) and the chat route's choice (:542-547). It
      // legitimately differs from `work_email` for a personal or alternate
      // sign-in, and from `effectiveEmail` when an elevated viewer filed from
      // somebody's dashboard — which is exactly the fact worth keeping.
      filed_by_email: authz.sessionEmail,
      member_name: identity.member_name,
      department: identity.department,
      category: body.category,
      concern,
      flagged_at: flaggedAt,
      flag_reason: flagReason,
    })
    .select(TICKET_SELECT)
    .limit(1);

  if (error) {
    // INSERT … RETURNING is one statement, so a missing column here means
    // nothing was inserted — the sentence below is true.
    if (classifyColumnProbe(error) === 'MISSING') {
      return NextResponse.json({ migrated: false, ticket: null, error: NOT_MIGRATED }, { status: 503 });
    }
    return NextResponse.json({ migrated: true, ticket: null, error: error.message }, { status: 500 });
  }

  const row = (data?.[0] as TicketDbRow | undefined) ?? null;
  if (!row) {
    return NextResponse.json(
      {
        migrated: true,
        ticket: null,
        error: 'The ticket was not created. Nothing was saved — please try again.',
      },
      { status: 500 },
    );
  }

  void insertAuditLog({
    ...auditFrom(request, authz),
    action: 'employee_support.ticket.filed',
    resource: TICKETS_TABLE,
    resource_id: row.id,
    details: {
      ticket_no: row.ticket_no,
      work_email: identity.work_email,
      category: row.category,
      // A flag is audited (plan task 13). The REASON is screening's sentence
      // about the text, never the text itself.
      flagged: flagReason !== null,
      flag_reason: flagReason,
      // True ONLY when an elevated viewer acted for somebody else. Compared
      // against effectiveEmail, never work_email: a personal-address sign-in
      // differs from the master email and is not acting on behalf.
      on_behalf: authz.sessionEmail !== authz.effectiveEmail,
    },
  });

  announce(row.id, 'ticket');
  void notifyTicketFiled(row);

  // A fresh ticket has zero replies. That is a fact, not a guess, so the
  // summary is the empty one and not `null`.
  return NextResponse.json({
    migrated: true,
    ticket: toWire(row, emptyThread()),
    promise: SUPPORT_REPLY_PROMISE,
    error: null,
  });
}
