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
import type { ChatSessionStatus } from '@/lib/support/chat-types';
import { nextWaiter, sortQueue, type QueueRank } from '@/lib/support/queue';
import {
  summarizeChatAvailability,
  type ChatAvailability,
} from '@/lib/support/availability';
import { releasedSystemLine } from '@/lib/support/abandonment';
// The sweep and the reads it rides on were lifted out of this file on
// 2026-09-21 so the EMPLOYEE GET can run them too — see chat-sweep.ts.
import {
  SESSIONS_TABLE,
  SESSION_SELECT,
  TICKETS_TABLE,
  announce,
  completeConversion,
  readAgents,
  readOpenSessions,
  sweepChatQueue,
  systemLine,
  type ChatSessionRow,
} from '@/lib/support/chat-sweep';
import { formatSupportTicketNo } from '@/lib/support/types';
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
 *           { action: 'address', session_id }   take THIS one and start its ticket
 *           { action: 'release', session_id }   hand a claim back to the line
 *           { action: 'end',     session_id }   close a conversation
 *
 * KANE, 2026-09-21 — TWO RULINGS LAND ON THIS ROUTE
 * ---------------------------------------------------------------------------
 * 1. *"the support team should be able to click that chat without reading it
 *    yet and see what the concern is about"* — every session on the wire now
 *    carries `category`, the employee's own answer to *what is this about*
 *    (`2026-09-21_employee_support_chat_category.sql`). An agent choosing what
 *    to pick up no longer has to open somebody's pay dispute to find out it is
 *    a Roboform lockout.
 * 2. *"they can click to address that concern and if they address that concern
 *    it should be able to start the ticket"* — {@link address}. Until today
 *    only an ABANDONED chat became a ticket; now an ANSWERED one does too, so
 *    every chat leaves a durable record either way. See that function for the
 *    order of operations and for what the database will not yet let it write.
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
 * **THAT GAP IS CLOSED (2026-09-21).** This was once the only route that swept,
 * which meant Kane's Q1 promise fired only while an agent was looking — and the
 * chats that go unanswered are precisely the ones nobody is watching. The sweep
 * now lives in `src/lib/support/chat-sweep.ts` and the EMPLOYEE's own GET calls
 * it as well, so an employee checking their place converts their own expired
 * chat. Do not move it back into a route module: a route cannot export a
 * helper, and a single-caller sweep is the defect this feature already had once.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 * * **No auto-toggle onto the queue.** Claiming a chat does not declare an
 *   agent available. Q4 is *an explicit toggle, never presence*, and writing a
 *   declaration on somebody's behalf is the same mistake as inferring one.
 *   `app/api/support/chat/availability/route.ts` owns that column.
 * * **No claiming of a SPECIFIC session — by `claim`.** That verb takes the
 *   next waiter (plan `:30-31`), because a queue where agents cherry-pick is a
 *   queue where position stops meaning anything, and position is the one number
 *   the employee is shown. `address` DOES name a session, and that is Kane's
 *   2026-09-21 ruling overriding this rule for that verb only: he asked to see
 *   what a chat is about and then click to address *that* concern. Nobody's
 *   POSITION changes either way — it is a count of who is still waiting ahead
 *   of you, so a chat taken out of order costs the people behind it nothing.
 * * **No message bodies.** Those are the messages route's, and nothing here
 *   reads or returns one.
 */


/** The feature key from the `employee_support` catalog (`feature-permissions.ts:121`). */
const SUPPORT_CHAT_FEATURE = 'support_chat';


/**
 * The two statuses a claim can be released or ended FROM. Not `waiting` — there
 * is nothing to hand back — and not `ended`/`abandoned`, whose books are shut.
 */
const HELD_STATUSES = ['claimed', 'live'] as const satisfies readonly ChatSessionStatus[];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


/** What the agent board renders. No message bodies, no `filed_by_email`. */
type QueueSessionWire = {
  id: string;
  session_no: number;
  status: ChatSessionStatus;
  work_email: string;
  member_name: string | null;
  department: string | null;
  /**
   * WHAT THE CHAT IS ABOUT, without opening it — Kane, 2026-09-21.
   *
   * `string | null` and NOT `SupportCategory | null`, for the reason
   * `SweepSessionRow.category` states: the column's CHECK admits only the nine,
   * but this arrives as JSON from PostgREST and narrowing it here would be an
   * assertion dressed as a fact. The UI labels a recognised value through
   * `SUPPORT_CATEGORY_LABELS` and shows anything else as "Not given" — `null`
   * means NOBODY ASKED (a session from before the picker), which is a different
   * fact from `'other'` ("Something else", which they chose).
   */
  category: string | null;
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
  category: row.category,
  queued_at: row.queued_at,
  last_seen_at: row.last_seen_at,
  claimed_by: row.claimed_by,
  claimed_at: row.claimed_at,
});

/**
 * The ticket an {@link address} started, as the board needs to render it.
 *
 * `minted` is the difference between *"you have opened ES-1043"* and *"this
 * chat already had ES-1043"* — the second happens when Address is pressed
 * twice, or when the sweep got there first — and the copy an agent should see
 * is not the same in both cases.
 */
type AddressedTicketWire = {
  id: string;
  ticket_no: number;
  /** `ES-1043`, from the one formatter, so the agent and the employee read the same string. */
  label: string;
  status: string;
  claimed_by: string | null;
  minted: boolean;
};

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
  if (action === 'address' || action === 'release' || action === 'end') {
    const id = typeof body.session_id === 'string' ? body.session_id : '';
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ session: null, error: 'Chat not found.' }, { status: 404 });
    }
    if (action === 'address') return address(sb, request, authz, agent, id);
    return action === 'release'
      ? release(sb, request, authz, agent, id)
      : endChat(sb, request, authz, agent, id);
  }

  return NextResponse.json(
    { session: null, error: "Unknown action. Use 'claim', 'address', 'release' or 'end'." },
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
 * Take the ticket for the agent who addressed the chat, and report it as it IS.
 *
 * WHY THE TICKET IS CLAIMED AND NOT LEFT IN THE LINE UNOWNED. `lifecycle.ts`
 * (`AUTO_CLAIM_ACTS`) says a touch auto-claims, and addressing is the most
 * deliberate touch there is: somebody is in the conversation right now.
 * A ticket left unheld for a question already being answered invites a second
 * answerer to pick it up and start again.
 *
 * A COMPARE-AND-SET, and zero rows is NOT an error: `WHERE status = 'open' AND
 * claimed_by IS NULL` is the state a freshly minted chat ticket is always in,
 * so zero rows means this chat already had a ticket and somebody already holds
 * it. That is somebody else's claim and it stands — hence the read-back, so the
 * answer describes the ticket as it is rather than as this request wanted it.
 *
 * `null` only when the ticket cannot be READ at all, which the caller reports
 * as "started, but we cannot show it" rather than as a failure to start it.
 */
const ADDRESSED_TICKET_COLS = 'id, ticket_no, status, claimed_by';

type AddressedTicketRow = { ticket_no: number; status: string; claimed_by: string | null };

async function takeTicket(
  sb: SupabaseClient,
  ticketId: string,
  agent: string,
): Promise<AddressedTicketRow | null> {
  const claimed = await sb
    .from(TICKETS_TABLE)
    .update({ status: 'claimed', claimed_by: agent, claimed_at: new Date().toISOString() })
    .eq('id', ticketId)
    .eq('status', 'open')
    .is('claimed_by', null)
    .select(ADDRESSED_TICKET_COLS);
  if (!claimed.error) {
    const row = (claimed.data?.[0] as AddressedTicketRow | undefined) ?? null;
    if (row) return row;
  }

  const read = await sb.from(TICKETS_TABLE).select(ADDRESSED_TICKET_COLS).eq('id', ticketId).limit(1);
  if (read.error) return null;
  return (read.data?.[0] as AddressedTicketRow | undefined) ?? null;
}

/**
 * ADDRESS — take THIS chat and start its ticket. Kane, 2026-09-21.
 *
 * *"For the chat the support team should be able to click that chat without
 * reading it yet and see what the concern is about and then they can click to
 * address that concern and if they address that concern it should be able to
 * start the ticket."*
 *
 * Until today a chat became a ticket only by going UNANSWERED (`chat-sweep.ts`,
 * Kane's Q1). Now an answered one does too, so a chat can no longer vanish
 * without a trace: **chat is the intake channel, the ticket is the record.**
 * That is a simplification of the rule, not a second feature.
 *
 * THE ORDER IS THE DESIGN, AND IT IS CLAIM FIRST
 * ---------------------------------------------------------------------------
 * The claim is the compare-and-set that decides who won
 * (`WHERE status = 'waiting' AND claimed_by IS NULL`, the plan's invariant
 * `:95-96`, written the way `app/api/payment-dispatches/route.ts:230-249`
 * writes one). A loser of that race mints NOTHING: it answers 409 with copy
 * saying nothing was recorded, and the WHERE is never widened to make the retry
 * succeed. If the ticket came first, two agents pressing together would both
 * mint before either discovered they had lost — the two-numbers-for-one-question
 * outcome `abandonment.ts:178-193` exists to prevent.
 *
 * ONE MINTING PATH. It calls `completeConversion`, the same function the sweep
 * calls, with `kind: 'addressed'`. A second copy of that logic here is how the
 * two would drift into minting twice.
 *
 * PRESSING IT TWICE IS SAFE. `completeConversion` looks the ticket up by the
 * `[ESC-nnnn]` marker before minting, so a chat that already has a ticket
 * attaches to it (`minted: false`) and the employee is not told twice. The
 * retry path below is deliberate rather than tolerated: a first press that
 * claimed the chat but failed to start the ticket is fixed by pressing again.
 *
 * THE SESSION DOES NOT BECOME `abandoned`, AND MUST NOT
 * ---------------------------------------------------------------------------
 * It becomes `claimed` — the status the schema defines as *"an agent has taken
 * it, the first word has not been said"* (SQL `:104-108`), which is exactly
 * what has happened. It moves to `live` by itself on the agent's first message
 * (the messages route), so this path never writes `live` either: that would
 * claim a conversation had started before anybody said anything. And
 * `abandoned` is reserved for the expiry path, because it is the one status
 * that means *nobody answered you* — the employee's own copy reads "Became a
 * ticket" off it (`chat-types.ts`), and the sweep's system line says nobody was
 * able to pick this up. Writing it here would tell somebody who is being helped
 * that they were not.
 *
 * ⚠ CONSEQUENCE, AND IT IS THE ONE OPEN THING ON THIS PATH. Because the session
 * stays `claimed`, `employee_support_chat_sessions_only_abandoned_becomes_ticket`
 * (SQL `:174-175`) forbids stamping `became_ticket_id`, so the session cannot
 * yet point AT the ticket it started. Nothing is loosened to get around it —
 * see THE STAMP in `chat-sweep.ts`, which names the two migrations that would
 * fix it and why the second is the better one. The ticket still points at the
 * chat (the `[ESC-nnnn]` marker in its concern), which is what idempotence
 * actually rides on; what is missing is only the reverse pointer, so the queue
 * cannot re-display the number after a reload until that migration lands.
 */
async function address(
  sb: SupabaseClient,
  request: Request,
  authz: AuthzOk,
  agent: string,
  sessionId: string,
) {
  const open = await readOpenSessions(sb);
  if (!open.migrated) {
    return NextResponse.json(
      { migrated: false, session: null, ticket: null, error: 'Live chat is not switched on yet. Nothing was changed.' },
      { status: 503 },
    );
  }
  if (open.error) {
    return NextResponse.json(
      { migrated: true, session: null, ticket: null, error: open.error },
      { status: 500 },
    );
  }

  const target = open.rows.find((r) => r.id === sessionId) ?? null;
  if (!target) {
    // One answer for "no such chat", "it already ended" and "it was converted",
    // the same rule {@link release} states: three distinguishable answers would
    // be three ways to probe a session id.
    return NextResponse.json(
      { migrated: true, session: null, ticket: null, error: 'Chat not found.' },
      { status: 404 },
    );
  }

  // One agent holds one conversation (plan `:30-33`), the same POLITE check
  // {@link claim} makes and with the same honest caveat: no index enforces it,
  // so two tabs clicking together can both pass. The cost is one agent holding
  // two chats — a scheduling annoyance, not a corrupted row.
  const elsewhere = open.rows.find(
    (r) =>
      r.id !== sessionId &&
      normEmail(r.claimed_by) === agent &&
      (r.status === 'claimed' || r.status === 'live'),
  );
  if (elsewhere) {
    return NextResponse.json(
      {
        migrated: true,
        session: toWire(elsewhere),
        ticket: null,
        error: 'You are already in a chat. Finish it before taking the next one — nothing was changed.',
      },
      { status: 409 },
    );
  }

  let held: ChatSessionRow;

  if (target.status === 'waiting') {
    const nowIso = new Date().toISOString();
    const { data, error } = await sb
      .from(SESSIONS_TABLE)
      .update({ status: 'claimed', claimed_by: agent, claimed_at: nowIso })
      .eq('id', target.id)
      // THE COMPARE. Both halves, exactly as {@link claim} does it: either
      // alone would let this land on a row the other half had already moved.
      .eq('status', 'waiting')
      .is('claimed_by', null)
      .select(SESSION_SELECT);

    if (error) {
      if (classifyTableProbe(error) === 'MISSING') {
        return NextResponse.json(
          { migrated: false, session: null, ticket: null, error: 'Live chat is not switched on yet. Nothing was changed.' },
          { status: 503 },
        );
      }
      return NextResponse.json(
        { migrated: true, session: null, ticket: null, error: error.message },
        { status: 500 },
      );
    }

    const row = (data?.[0] as ChatSessionRow | undefined) ?? null;
    if (!row) {
      // Lost the claim, so NOTHING is minted. The employee is somebody else's
      // to answer and this request wrote nothing at all.
      return NextResponse.json(
        { migrated: true, session: null, ticket: null, error: LOST_RACE },
        { status: 409 },
      );
    }
    held = row;

    // The same line {@link claim} writes, and for the same reason: the employee
    // learns from the transcript that somebody arrived, without this route
    // handing out a staffer's address or name.
    await systemLine(sb, held.id, 'An agent has joined the chat.');
    announce(held.id, 'session');

    void insertAuditLog({
      ...auditFrom(request, authz),
      action: 'employee_support.chat.claimed',
      resource: SESSIONS_TABLE,
      resource_id: held.id,
      details: { session_no: held.session_no, work_email: held.work_email, via: 'address' },
    });
  } else if (
    (target.status === 'claimed' || target.status === 'live') &&
    normEmail(target.claimed_by) === agent
  ) {
    // ALREADY MINE — the retry. The chat was taken by a previous press whose
    // ticket did not get started (or did, and this press will attach to it).
    // Re-claiming is not attempted: it is already claimed, by me, and a second
    // claim write would move `claimed_at` and make the record say this
    // conversation started later than it did.
    held = target;
  } else {
    return NextResponse.json(
      {
        migrated: true,
        session: toWire(target),
        ticket: null,
        error: 'Somebody else is holding this chat. Nothing was changed — refresh the queue.',
      },
      { status: 409 },
    );
  }

  const conversion = await completeConversion(sb, request, authz, held, 'addressed');
  if (!conversion.ok || conversion.ticketId === null || conversion.ticketNo === null) {
    // HALF DONE, AND THE ANSWER SAYS SO. The chat IS claimed — a 4xx/5xx here
    // would tell the agent nothing happened, and they would go back to a queue
    // that no longer shows the chat they are now holding. The likeliest cause
    // by far is the 2026-09-16 ticket migration not having been applied, whose
    // live state has never been verified.
    return NextResponse.json({
      migrated: true,
      session: toWire(held),
      ticket: null,
      error:
        'You are in this chat, but its ticket could not be started. Press Address again to retry — a chat can only ever get one number.',
    });
  }

  // The transcript gained the ticket line, so the EMPLOYEE's dialog must
  // re-read. `message` rather than a second `session` frame: the employee's
  // listener answers a matching `message` by re-running both its session GET
  // and its thread (`EmployeeSupportChat.tsx:655-676`), which is exactly what
  // is needed, and a `session` frame would fan out to everybody else in the
  // line for a change that does not move anyone's position.
  announce(held.id, 'message');

  const ticketRow = await takeTicket(sb, conversion.ticketId, agent);
  const ticket: AddressedTicketWire = {
    id: conversion.ticketId,
    ticket_no: ticketRow?.ticket_no ?? conversion.ticketNo,
    label: formatSupportTicketNo(ticketRow?.ticket_no ?? conversion.ticketNo),
    // `null` here is "we could not read it back", never "nobody holds it" —
    // the claim may well have landed. The board re-reads through the tickets
    // route rather than trusting this field to be the whole truth.
    status: ticketRow?.status ?? 'open',
    claimed_by: ticketRow?.claimed_by ?? null,
    minted: conversion.minted,
  };

  return NextResponse.json({ migrated: true, session: toWire(held), ticket, error: null });
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
