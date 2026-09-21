import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { deniedResponse, type AuthzOk } from '@/lib/auth/authorize-email';
import { requireFeatureAccessAnyView } from '@/lib/auth/authorize-feature';
import { auditFrom } from '@/lib/audit/context';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { classifyColumnProbe } from '@/lib/db/probe-verdict';
import { normEmail } from '@/lib/email/norm-email';
import {
  fetchFeaturePermissionsForEmail,
  resolveFeatureAccess,
} from '@/lib/rbac/feature-permissions';
import {
  COUNTS_UNRESOLVED,
  isSupportPriority,
  partitionStages,
  sortBoard,
  stageOf,
  supportCounts,
  type SupportPriority,
  type TicketStage,
  type TriageRow,
} from '@/lib/support/triage';
import { canStaffAct, type Actor, type SupportAct } from '@/lib/support/lifecycle';
import {
  formatSupportTicketNo,
  needsStaffReply,
  type SupportStatus,
} from '@/lib/support/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Employee Support — the STAFF board: the queueing line, the board, the counts.
 *
 * Plan: docs/superpowers/plans/2026-09-21-employee-support-tickets-board.md
 * (task 6). Table: references/sql/create/2026-09-16_employee_support.sql plus
 * references/sql/alter/2026-09-21_employee_support_triage.sql.
 *
 *   GET   → { migrated, line, board, answered, closed, counts, me }
 *           every open question in display order, split into Kane's two stages,
 *           with Carla's two counts spanning BOTH of them.
 *   PATCH → { action: 'claim',    ticket_id }
 *           { action: 'rank',     ticket_id, priority }   null demotes to the line
 *           { action: 'reassign', ticket_id, to_email }
 *
 * THE RULES ARE NOT IN THIS FILE, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 * `src/lib/support/triage.ts` owns the two stages, the sort and the counts;
 * `src/lib/support/lifecycle.ts` owns who may do what and what each act does.
 * This route reads, asks them, and writes. Nothing here re-derives a rule —
 * the board disables its buttons from the same two modules, so a control can
 * never be enabled for something this route will refuse.
 *
 * EVERY WRITE IS A COMPARE-AND-SET, AND A LOST RACE IS A 409
 * ---------------------------------------------------------------------------
 * The plan's invariant (`:108-110`): the claim is a compare-and-set on NULL and
 * the handoff is a compare-and-set on the CURRENT holder. Two guarded UPDATEs,
 * never one loosened one — written the way
 * `app/api/payment-dispatches/route.ts:230-249` writes a payment claim. Every
 * read that precedes a write here is a check-then-act, so the condition that
 * authorised the act is repeated in the UPDATE's own WHERE clause
 * (`app/api/contractor/invoices/[id]/route.ts:118-145`); zero rows back is a
 * **409 whose copy states that nothing was recorded**, never a retry and never
 * a widened WHERE.
 *
 * `first_response_at` IS NOT TOUCHED HERE. It is stamped once, by the reply
 * route, and never recomputed — a "time to first response" that moves is not a
 * measurement.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 * * **No filing.** Nothing creates an `employee_support_tickets` row on this
 *   route. Today they arrive one way — an unanswered or an ADDRESSED live chat
 *   (`chat-sweep.ts`) — and the employee's own filing form is the next build.
 * * **No reply, close or reopen.** Those are `[id]/reply/route.ts`, which is
 *   gated differently (at `view`, see its header).
 * * **No cron.** `docs/features/INDEX.md:42`. Nothing on this surface expires.
 */

const TICKETS_TABLE = 'employee_support_tickets';

/**
 * The feature key added to the EXISTING `employee_support` catalog
 * (`feature-permissions.ts:135-138`), mirroring how the chat routes consume
 * `support_chat`. No new role and no new view: `ticketsHostAccess` already
 * returns every granted support tab (`view-tabs.ts:272-287`).
 */
const SUPPORT_TICKETS_FEATURE = 'support_tickets';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One sentence for every lost race, so the branches cannot drift apart. */
const LOST_RACE = 'Somebody else got there first. Nothing was recorded — refresh the board.';

/** Said when the tables (or the triage columns) are not there yet. */
const NOT_MIGRATED = 'Employee Support tickets are not switched on yet. Nothing was changed.';

/**
 * How far back the CLOSED read reaches for the "answered today" count.
 *
 * A coarse superset on purpose: the precise test is a calendar day in the
 * SUPPORT zone and it belongs to `supportCounts`, which already does it
 * (`triage.ts`, `supportDayIso`). Asking PostgREST for "today in New York"
 * would mean computing that boundary here in a second place, in UTC, and being
 * wrong twice a year. 48 hours covers every offset and a late-night close.
 */
const ANSWERED_TODAY_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * The closed list is a BROWSE list, and the one read on this route that is
 * deliberately bounded rather than paged.
 *
 * Carla signed *"Nothing is deleted — closed questions stay readable by both"*,
 * so closed tickets must be reachable; they are also the only set here that
 * grows without limit. Nothing is COMPUTED over it — the counts come from the
 * open set plus the 48-hour window above — so a bound is not a truncated
 * calculation, and `has_more` tells the caller it is looking at a window rather
 * than at everything. Every set the code reasons about still pages.
 */
const CLOSED_LIMIT = 100;

/* ─────────────────────────────── the rows ───────────────────────────────── */

/**
 * Every column the board needs, read once. `priority`, `triaged_at` and
 * `triaged_by` are the triage ALTER's — naming them is also what makes a
 * missing migration a clean `migrated: false` instead of a 500, because
 * PostgREST answers an unknown column with `42703`/`PGRST204` and
 * `classifyColumnProbe` reads that as MISSING.
 *
 * ONE STRING LITERAL, NEVER A CONCATENATION. The typed Supabase client parses
 * this at compile time and checks the result against {@link TicketDbRow}, so a
 * column left out of the list is a `tsc` error rather than an `undefined` that
 * reads as "no priority" — which is exactly how the chat conversion filed every
 * ticket as `other` for a day. Joining two strings defeats that parser and the
 * check silently becomes nothing.
 */
const TICKET_SELECT =
  'id, ticket_no, work_email, member_name, department, category, concern, status, priority, triaged_at, triaged_by, claimed_by, claimed_at, first_response_at, closed_by, closed_at, flagged_at, flag_reason, created_at, updated_at';

type TicketDbRow = {
  id: string;
  ticket_no: number;
  work_email: string;
  member_name: string | null;
  department: string | null;
  category: string;
  concern: string;
  /**
   * Typed against the vocabulary, the way `SweepSessionRow.status` is: the
   * column has carried `employee_support_tickets_status_valid` since it
   * shipped (`2026-09-16_employee_support.sql:85-87`), so the four values are
   * a database fact rather than an assumption of this file.
   */
  status: SupportStatus;
  /** Raw text off the wire. Narrowed — never asserted — by {@link toWire}. */
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

/**
 * What the board renders.
 *
 * `filed_by_email` is deliberately absent, the same omission the chat queue
 * makes: the master `work_email` is who this is, and the address the session
 * happened to carry answers a question the board is not asking.
 *
 * The flag columns ARE here. A flag is a note to whoever is about to open a
 * complaint, which is the whole reason screening records instead of blocking.
 */
type SupportTicketWire = TriageRow & {
  id: string;
  ticket_no: number;
  /** `ES-1043`, from the one formatter, so staff and employee read one string. */
  label: string;
  work_email: string;
  member_name: string | null;
  department: string | null;
  category: string;
  concern: string;
  status: SupportStatus;
  priority: SupportPriority;
  /** Derived by `triage.ts`, never stored and never re-derived in a component. */
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
  /** `needsStaffReply`, so the row and the count cannot disagree about it. */
  needs_reply: boolean;
};

function toWire(row: TicketDbRow): SupportTicketWire {
  // NARROWED, NOT ASSERTED. `isSupportPriority` is the guard `triage.ts` owns;
  // anything it does not recognise reads as `null`, which means "in the line" —
  // visible, un-triaged and waiting for somebody, rather than a value the
  // comparator would have to invent a rank for. The CHECK admits only the four,
  // so this is the same belt-and-braces `chatTicketCategory` applies on the
  // conversion path.
  const priority: SupportPriority = isSupportPriority(row.priority) ? row.priority : null;
  const triage = {
    status: row.status,
    priority,
    created_at: row.created_at,
    first_response_at: row.first_response_at,
  };
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

/**
 * `triage.ts`'s partition and sort, with the caller's own row type preserved.
 *
 * THE TWO CASTS HERE ARE THE ONLY ONES IN THIS FILE and they are sound:
 * `partitionStages` filters and `sortBoard` copies the ARRAY, never the
 * elements, so every object coming out is an object that went in. `TriageRow`
 * is the minimum contract those functions need and their signatures cannot say
 * "whatever you handed me". The alternative is re-implementing the partition
 * and the comparator here, which is the one thing a route must not do with
 * these rules — the board would then disagree with the module the UI disables
 * its buttons from.
 */
function stagesOf<T extends TriageRow>(rows: readonly T[]): { line: T[]; board: T[] } {
  const { line, board } = partitionStages(rows);
  return { line: line as T[], board: board as T[] };
}

function ordered<T extends TriageRow>(rows: readonly T[]): T[] {
  return sortBoard(rows) as T[];
}

/* ─────────────────────────────── gate ───────────────────────────────────── */

/**
 * Gate + client, at the level this verb needs.
 *
 * READS take `view`; every WRITE on THIS route takes `edit`. Claiming, ranking
 * and handing a ticket on are the acts that decide who is answering an
 * employee's pay dispute, and somebody deliberately granted `view` and not
 * `edit` on this catalog was held back from exactly that. Nothing is narrowed
 * for the five answerers: granting the `employee_support` role auto-provisions
 * `edit` (`provisionDashboardTabs`).
 *
 * The REPLY is the documented exception and it lives in the other file — see
 * `[id]/reply/route.ts`, which the plan (`:144-146`) gates at `view`.
 */
async function prepare(
  level: 'view' | 'edit',
): Promise<{ ok: true; authz: AuthzOk; sb: SupabaseClient } | { ok: false; response: NextResponse }> {
  const authz = await requireFeatureAccessAnyView(SUPPORT_TICKETS_FEATURE, level);
  if (!authz.ok) return { ok: false, response: deniedResponse(authz) };

  const sb = createSupabaseServiceRoleClient();
  if (!sb) {
    // No `migrated` key here: nothing has asked the database anything, so
    // nothing may claim an answer about whether the migration ran.
    return {
      ok: false,
      response: NextResponse.json({ error: 'Employee Support is unavailable right now.' }, { status: 503 }),
    };
  }
  return { ok: true, authz, sb };
}

/** Who is asking, as `lifecycle.ts` wants it. The email is the SESSION's, never the body's. */
function actorOf(authz: AuthzOk): Actor | null {
  const email = normEmail(authz.sessionEmail);
  if (!email) return null;
  return { email, isAdmin: authz.roles.includes('admin') };
}

/* ─────────────────────────────── reads ──────────────────────────────────── */

type ReadResult = { rows: TicketDbRow[]; error: string | null; migrated: boolean };

/**
 * How a paged read's outcome is reported. A missing TABLE and a missing triage
 * COLUMN are the same answer to the caller — the migration has not run — and
 * `classifyColumnProbe` covers both (it returns MISSING for an absent parent
 * table too).
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
 * Everything still open in any sense: `open`, `claimed` and `answered`.
 *
 * Paged, because PostgREST caps a result set at 1000 rows with no error and an
 * unpaged read is a confidently wrong board — and this table is now fed by a
 * chat that mints a ticket for every conversation, answered or not.
 */
async function readWorking(sb: SupabaseClient): Promise<ReadResult> {
  const { rows, error } = await selectAllPaged<TicketDbRow>((from, to) =>
    sb
      .from(TICKETS_TABLE)
      .select(TICKET_SELECT)
      .neq('status', 'closed')
      // A stable order so pages cannot shear under a concurrent write. The
      // DISPLAY order is `triage.ts`'s and is applied after the read.
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  return settle(rows, error);
}

/** Recently closed, for the "answered today" count only. See the window constant. */
async function readRecentlyClosed(sb: SupabaseClient, now: Date): Promise<ReadResult> {
  const since = new Date(now.getTime() - ANSWERED_TODAY_WINDOW_MS).toISOString();
  const { rows, error } = await selectAllPaged<TicketDbRow>((from, to) =>
    sb
      .from(TICKETS_TABLE)
      .select(TICKET_SELECT)
      .eq('status', 'closed')
      .gte('first_response_at', since)
      .order('first_response_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  return settle(rows, error);
}

/** One ticket, for a write to be judged against. */
async function readTicket(
  sb: SupabaseClient,
  id: string,
): Promise<{ ok: true; row: TicketDbRow } | { ok: false; migrated: boolean; error: string | null }> {
  const { data, error } = await sb.from(TICKETS_TABLE).select(TICKET_SELECT).eq('id', id).limit(1);
  if (error) {
    if (classifyColumnProbe(error) === 'MISSING') return { ok: false, migrated: false, error: null };
    return { ok: false, migrated: true, error: error.message };
  }
  const row = (data?.[0] as TicketDbRow | undefined) ?? null;
  if (!row) return { ok: false, migrated: true, error: null };
  return { ok: true, row };
}

/* ──────────────────────────────── GET ───────────────────────────────────── */

/**
 * GET — the whole open set, split into Kane's two stages, plus Carla's counts.
 *
 * `?closed=1` additionally returns the most recently closed window. It is off
 * by default because the default view is the line (plan `:99-101`): an
 * un-triaged ticket nobody ranks never reaches the board, and starvation is the
 * failure mode a hidden line produces.
 *
 * THREE ARRAYS, NOT TWO, AND THE THIRD IS NOT AN AFTERTHOUGHT. `isOpenTicket`
 * — which mirrors the SQL's `..._open_idx` predicate — is `open` or `claimed`,
 * so an ANSWERED ticket is in neither stage: it is nobody's next action, it is
 * waiting on the employee. It still comes back, in its own array, because
 * Carla signed *"One screen listing every question"* and a ticket that
 * disappears the moment it is answered is a ticket nobody can follow up.
 */
export async function GET(request: Request) {
  const prepared = await prepare('view');
  if (!prepared.ok) return prepared.response;
  const { authz, sb } = prepared;

  const wantClosed = new URL(request.url).searchParams.get('closed') === '1';
  const now = new Date();

  const working = await readWorking(sb);
  if (!working.migrated) {
    return NextResponse.json({
      migrated: false,
      line: [],
      board: [],
      answered: [],
      closed: null,
      closed_has_more: false,
      // Never zeroes on an unread set: "nobody needs a reply" and "we could not
      // look" are different things to put in front of somebody deciding
      // whether to go home.
      counts: { ...COUNTS_UNRESOLVED },
      me: { email: authz.sessionEmail, is_admin: authz.roles.includes('admin') },
      error: null,
    });
  }
  if (working.error) {
    return NextResponse.json(
      {
        migrated: true,
        line: [],
        board: [],
        answered: [],
        closed: null,
        closed_has_more: false,
        counts: { ...COUNTS_UNRESOLVED },
        me: { email: authz.sessionEmail, is_admin: authz.roles.includes('admin') },
        error: working.error,
      },
      { status: 500 },
    );
  }

  const wires = working.rows.map(toWire);
  const { line, board } = stagesOf(wires);
  // Everything the two stages do not carry. Same comparator, so a ticket does
  // not jump when it is answered.
  const answered = ordered(wires.filter((t) => t.status === 'answered'));

  // The counts span BOTH stages and reach past them: a ticket answered AND
  // closed today still counts as answered today. A failed window read makes
  // the counts UNRESOLVED rather than understated — `supportCounts(null, …)`
  // is the module's own way of saying "we could not tell".
  const window = await readRecentlyClosed(sb, now);
  const counted =
    window.migrated && !window.error ? [...wires, ...window.rows.map(toWire)] : null;
  const counts = supportCounts(counted, now);

  let closed: SupportTicketWire[] | null = null;
  let closedHasMore = false;
  if (wantClosed) {
    const recent = await sb
      .from(TICKETS_TABLE)
      .select(TICKET_SELECT)
      .eq('status', 'closed')
      .order('closed_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(CLOSED_LIMIT + 1);
    if (!recent.error) {
      const rows = (recent.data ?? []) as TicketDbRow[];
      closedHasMore = rows.length > CLOSED_LIMIT;
      closed = rows.slice(0, CLOSED_LIMIT).map(toWire);
    }
  }

  return NextResponse.json({
    migrated: true,
    line,
    board,
    answered,
    closed,
    closed_has_more: closedHasMore,
    counts,
    me: { email: authz.sessionEmail, is_admin: authz.roles.includes('admin') },
    error: null,
  });
}

/* ─────────────────────────────── PATCH ──────────────────────────────────── */

type PatchBody = {
  action?: unknown;
  ticket_id?: unknown;
  priority?: unknown;
  to_email?: unknown;
};

/** The three verbs this route serves. Reply, close and reopen are the other file's. */
const BOARD_ACTS = ['claim', 'rank', 'reassign'] as const satisfies readonly SupportAct[];
type BoardAct = (typeof BOARD_ACTS)[number];

const isBoardAct = (value: unknown): value is BoardAct =>
  typeof value === 'string' && (BOARD_ACTS as readonly string[]).includes(value);

export async function PATCH(request: Request) {
  const prepared = await prepare('edit');
  if (!prepared.ok) return prepared.response;
  const { authz, sb } = prepared;

  let body: PatchBody;
  try {
    body = ((await request.json()) as PatchBody) ?? {};
  } catch {
    return NextResponse.json({ ticket: null, error: 'Invalid request body' }, { status: 400 });
  }

  const actor = actorOf(authz);
  if (!actor) return NextResponse.json({ ticket: null, error: 'Not signed in' }, { status: 401 });

  if (!isBoardAct(body.action)) {
    return NextResponse.json(
      { ticket: null, error: "Unknown action. Use 'claim', 'rank' or 'reassign'." },
      { status: 400 },
    );
  }
  const act: BoardAct = body.action;

  const id = typeof body.ticket_id === 'string' ? body.ticket_id : '';
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ticket: null, error: 'Ticket not found.' }, { status: 404 });
  }

  const found = await readTicket(sb, id);
  if (!found.ok) {
    if (!found.migrated) {
      return NextResponse.json({ migrated: false, ticket: null, error: NOT_MIGRATED }, { status: 503 });
    }
    if (found.error) {
      return NextResponse.json({ migrated: true, ticket: null, error: found.error }, { status: 500 });
    }
    return NextResponse.json({ migrated: true, ticket: null, error: 'Ticket not found.' }, { status: 404 });
  }
  const ticket = toWire(found.row);

  // THE VERDICT, from the one module that owns it. A 409 and not a 403: the
  // GRANT was already checked by the gate above, so every refusal below is
  // about the state of this ticket — already closed, already held by somebody
  // else — which is the conflict a 409 names and which a re-read resolves.
  const verdict = canStaffAct(act, ticket, actor);
  if (!verdict.allowed) {
    return NextResponse.json(
      { migrated: true, ticket, error: `${verdict.reason} Nothing was changed.` },
      { status: 409 },
    );
  }

  if (act === 'claim') return claim(sb, request, authz, actor, ticket);
  if (act === 'rank') return rank(sb, request, authz, actor, ticket, body.priority, verdict.claims);
  return reassign(sb, request, authz, actor, ticket, body.to_email);
}

/**
 * The claim half of any act, as the columns it writes.
 *
 * `status` is only present when the transition is real: `nextStatus('claim')`
 * moves an `open` ticket to `claimed` and leaves an `answered` one alone, and
 * writing the status back unchanged would be a second thing to keep true. The
 * pair moves together because `..._claim_both_or_neither` (SQL `:121-123`)
 * requires it, and `..._claimed_has_owner` requires the owner to be named in
 * the same write that sets the status.
 */
function claimPatch(ticket: SupportTicketWire, actor: Actor, nowIso: string): Record<string, unknown> {
  const patch: Record<string, unknown> = { claimed_by: actor.email, claimed_at: nowIso };
  if (ticket.status === 'open') patch.status = 'claimed';
  return patch;
}

/**
 * The shared tail of every write: read the UPDATE's own answer, or say that
 * nothing was recorded.
 *
 * It takes the rows already typed as {@link TicketDbRow}, so each call site
 * still gets the compile-time check that its `.select(TICKET_SELECT)` returned
 * every column the board renders — the check a cast here would have thrown
 * away for all three verbs at once.
 */
type WriteResult = {
  data: TicketDbRow[] | null;
  error: { message: string; code?: string | null } | null;
};

function answerWrite(
  result: WriteResult,
  fallback: SupportTicketWire,
): NextResponse | { row: TicketDbRow } {
  if (result.error) {
    if (classifyColumnProbe(result.error) === 'MISSING') {
      return NextResponse.json({ migrated: false, ticket: null, error: NOT_MIGRATED }, { status: 503 });
    }
    return NextResponse.json({ migrated: true, ticket: fallback, error: result.error.message }, { status: 500 });
  }
  const row = result.data?.[0] ?? null;
  if (!row) {
    return NextResponse.json({ migrated: true, ticket: fallback, error: LOST_RACE }, { status: 409 });
  }
  return { row };
}

/**
 * CLAIM — take an unheld ticket.
 *
 * The compare-and-set on NULL. `WHERE claimed_by IS NULL AND status <> 'closed'`
 * repeats both conditions the verdict was formed from: zero rows means somebody
 * claimed it or closed it between the read and this write, and the answer is a
 * 409 saying nothing was recorded.
 */
async function claim(
  sb: SupabaseClient,
  request: Request,
  authz: AuthzOk,
  actor: Actor,
  ticket: SupportTicketWire,
) {
  const nowIso = new Date().toISOString();
  const result = await sb
    .from(TICKETS_TABLE)
    .update(claimPatch(ticket, actor, nowIso))
    .eq('id', ticket.id)
    .is('claimed_by', null)
    .neq('status', 'closed')
    .select(TICKET_SELECT);

  const answered = answerWrite(result, ticket);
  if (answered instanceof NextResponse) return answered;

  void insertAuditLog({
    ...auditFrom(request, authz),
    action: 'employee_support.ticket.claimed',
    resource: TICKETS_TABLE,
    resource_id: ticket.id,
    details: { ticket_no: ticket.ticket_no, work_email: ticket.work_email },
  });

  return NextResponse.json({ migrated: true, ticket: toWire(answered.row), error: null });
}

/**
 * RANK — put a ticket on the board, move it within the board, or send it back
 * to the line.
 *
 * `priority: null` is a DEMOTION and is deliberately allowed: all three triage
 * columns go back to NULL together, because
 * `employee_support_tickets_triage_all_or_nothing` says a row can never claim
 * it was ranked without saying by whom. The previous rank is FORGOTTEN by the
 * row and REMEMBERED by `audit_log` — the answer this feature already gives for
 * handoff history, and the one the triage SQL states in as many words.
 *
 * ANYBODY ON THE TEAM MAY RANK, INCLUDING A TICKET SOMEBODY ELSE HOLDS
 * (`lifecycle.ts`): urgency is a property of the QUESTION, not of who is
 * answering it. Ranking an UNHELD ticket also claims it — `verdict.claims`,
 * Kane's *"whoever touches the ticket first"* — and both halves land in ONE
 * guarded UPDATE, so there is no window in which a ticket is ranked by somebody
 * it is not assigned to.
 */
async function rank(
  sb: SupabaseClient,
  request: Request,
  authz: AuthzOk,
  actor: Actor,
  ticket: SupportTicketWire,
  raw: unknown,
  claims: boolean,
) {
  // `null` is the demotion; anything else must be one of the four. Note what is
  // NOT done: no trimming, no lower-casing, no "close enough" match. The four
  // values are keys chosen from a fixed list, and coercing a near-miss is
  // guessing at what a caller meant — the same rule `chatTicketCategory` states.
  const isNull = raw === null;
  if (!isNull && !isSupportPriority(raw)) {
    return NextResponse.json(
      {
        migrated: true,
        ticket,
        error: "Pick an urgency of 'low', 'medium', 'high' or 'urgent' — or null to send it back to the line.",
      },
      { status: 400 },
    );
  }
  const priority: SupportPriority = isNull ? null : raw;

  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = {
    priority,
    triaged_at: priority === null ? null : nowIso,
    triaged_by: priority === null ? null : actor.email,
  };
  if (claims) Object.assign(patch, claimPatch(ticket, actor, nowIso));

  let update = sb.from(TICKETS_TABLE).update(patch).eq('id', ticket.id).neq('status', 'closed');
  // The check-then-act condition, carried into the WHERE. The verdict decided
  // whether to auto-claim by reading `claimed_by`; if that changed underneath
  // us the decision is stale, so the write must not land. A 409 and a re-read
  // is right in both directions — the retry then takes the other branch.
  update = claims ? update.is('claimed_by', null) : update.not('claimed_by', 'is', null);

  const result = await update.select(TICKET_SELECT);
  const answered = answerWrite(result, ticket);
  if (answered instanceof NextResponse) return answered;

  void insertAuditLog({
    ...auditFrom(request, authz),
    action: 'employee_support.ticket.ranked',
    resource: TICKETS_TABLE,
    resource_id: ticket.id,
    details: {
      ticket_no: ticket.ticket_no,
      // The row forgets a demotion; this is where it is remembered.
      from: ticket.priority,
      to: priority,
      stage: priority === null ? 'line' : 'board',
      auto_claimed: claims,
    },
  });

  return NextResponse.json({ migrated: true, ticket: toWire(answered.row), error: null });
}

/**
 * Does this person hold Employee Support tickets at all?
 *
 * A handoff to somebody with no grant is a ticket that vanishes: it stays open,
 * nobody sees it on their board, and the employee is still waiting. So the
 * target is checked, and FAILS CLOSED — `fetchFeaturePermissionsForEmail`
 * returns `{}` on a read error, which lands here as "no access" and refuses the
 * handoff rather than performing one nobody can undo.
 *
 * Alternate work emails are handled inside that function (it expands aliases),
 * which matters because a grant can sit on a person's primary address while the
 * picker offers another of theirs.
 *
 * An `admin` holds no grant row at all — admins bypass feature gating — so the
 * role is checked separately rather than being papered over by loosening the
 * grant test.
 */
async function canHoldSupportTickets(sb: SupabaseClient, email: string): Promise<boolean> {
  const perms = await fetchFeaturePermissionsForEmail(email);
  if (resolveFeatureAccess(perms, 'employee_support', SUPPORT_TICKETS_FEATURE) !== 'hidden') {
    return true;
  }
  const { data } = await sb
    .from('employee_roles')
    .select('work_email')
    .eq('work_email', email)
    .eq('role', 'admin')
    .is('revoked_at', null)
    .limit(1);
  return !!data && data.length > 0;
}

/**
 * REASSIGN — the handoff. Kane, 2026-09-18: *"unless they pass it off to
 * another person."*
 *
 * **The compare-and-set on the CURRENT holder**, the second half of the plan's
 * invariant. `WHERE claimed_by = <the holder we read>`: a ticket that moved
 * between the read and this write is not the ticket this decision was made
 * about, and the answer is a 409 rather than a widened WHERE.
 *
 * `first_response_at` is NOT cleared. The employee was answered at the time
 * they were answered, whoever owns the ticket now.
 */
async function reassign(
  sb: SupabaseClient,
  request: Request,
  authz: AuthzOk,
  actor: Actor,
  ticket: SupportTicketWire,
  raw: unknown,
) {
  const to = normEmail(typeof raw === 'string' ? raw : '');
  if (!to) {
    return NextResponse.json(
      { migrated: true, ticket, error: 'Say who is taking this one. Nothing was changed.' },
      { status: 400 },
    );
  }
  if (to === normEmail(ticket.claimed_by)) {
    return NextResponse.json(
      { migrated: true, ticket, error: 'They already hold this ticket. Nothing was changed.' },
      { status: 409 },
    );
  }
  if (!(await canHoldSupportTickets(sb, to))) {
    return NextResponse.json(
      {
        migrated: true,
        ticket,
        error: `${to} does not have Employee Support access, so the ticket would disappear. Nothing was changed.`,
      },
      { status: 409 },
    );
  }

  const result = await sb
    .from(TICKETS_TABLE)
    .update({ claimed_by: to, claimed_at: new Date().toISOString() })
    .eq('id', ticket.id)
    // THE COMPARE, on the holder this decision was made about. `ticket.claimed_by`
    // is non-null: `canStaffAct('reassign', …)` refuses an unheld ticket, and
    // this route never reaches here without its verdict.
    .eq('claimed_by', ticket.claimed_by ?? '')
    .neq('status', 'closed')
    .select(TICKET_SELECT);

  const answered = answerWrite(result, ticket);
  if (answered instanceof NextResponse) return answered;

  void insertAuditLog({
    ...auditFrom(request, authz),
    action: 'employee_support.ticket.reassigned',
    resource: TICKETS_TABLE,
    resource_id: ticket.id,
    details: { ticket_no: ticket.ticket_no, from: ticket.claimed_by, to, by_admin: actor.isAdmin },
  });

  // NO NOTIFICATION, and it is a decision. There is no `support.assigned` type
  // in `employee_notifications_type_check`, and inventing one means DDL that
  // has to be re-read against the live constraint before it can be applied
  // (`2026-09-21_support_notification_types.sql`). A handoff between five
  // people who share one board is visible ON that board and in `audit_log`;
  // the employee is told nothing because nothing changed for them.
  return NextResponse.json({ migrated: true, ticket: toWire(answered.row), error: null });
}
