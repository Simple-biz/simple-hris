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
import type { ChatSessionStatus } from '@/lib/support/chat-types';
import {
  AGENT_HEARTBEAT_MS,
  AGENT_STALE_AFTER_MS,
  agentHeartbeatAgeMs,
  isAgentOnQueue,
  summarizeChatAvailability,
  type ChatAgentRow,
  type ChatAvailability,
} from '@/lib/support/availability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Employee Support LIVE CHAT — the "I'm on the queue" toggle and its heartbeat.
 *
 * Plan: docs/superpowers/plans/2026-09-19-employee-support-chat.md (task 13).
 * Table: `employee_support_chat_agents`, references/sql/create/2026-09-19_employee_support_chat.sql:309-345.
 *
 *   GET   → { migrated, me, availability, heartbeat_ms, stale_after_ms }
 *   PATCH → { on_queue: boolean }  declare, or undeclare
 *   POST  → the heartbeat. No body. Refused when the caller is not declared on.
 *
 * KANE'S Q4: AN EXPLICIT TOGGLE, NEVER PRESENCE
 * ---------------------------------------------------------------------------
 * Nothing in this file reads `user_presence`, and nothing may start to, for two
 * independent reasons either of which would be enough:
 *
 * 1. **Presence is forgeable.** `POST /api/presence/heartbeat` takes the email
 *    from the REQUEST BODY when there is no NextAuth session
 *    (`SECURITY_AUDIT.md:245` row #50). Anyone could put Carla on the support
 *    queue. The row this route writes is keyed on `authz.sessionEmail` and on
 *    nothing a request said.
 * 2. **It answers a different question.** Presence means *a tab is open*;
 *    on-queue means *I am taking chats right now*. An agent doing payroll with
 *    the HRIS open all day is present and is not available.
 *
 * THE TOGGLE AND THE BEAT ARE TWO FACTS, AND THE BEAT MAY NOT CREATE ONE
 * ---------------------------------------------------------------------------
 * `on_queue` is a DECLARATION, `last_heartbeat_at` is EVIDENCE (SQL `:301-307`).
 * So the heartbeat is a **guarded UPDATE** — `WHERE agent_email = <me> AND
 * on_queue` — and never an upsert: a beat arriving from a tab that has not
 * noticed the agent toggled off somewhere else must not silently put them back
 * on the queue. Zero rows back is a 409 that tells the browser to stop beating.
 *
 * Toggling ON reuses that same guarded beat as its first step, which is what
 * keeps `on_queue_since` honest: an agent who is already on gets their beat
 * refreshed and their "on the queue since 9:04" left alone, and only a genuine
 * off→on transition writes a new `since`.
 *
 * EXPIRY IS LAZY, COMPARED ON READ. NOTHING HERE SWEEPS.
 * ---------------------------------------------------------------------------
 * `docs/features/INDEX.md:42` — *"Never add a cron"*. A stale agent's row is
 * left exactly as it is and simply stops passing `isAgentOnQueue`; see
 * `src/lib/support/availability.ts`, which owns every threshold and is pure.
 * This route also deliberately does NOT run the abandonment sweep: that rides
 * on the queue GET (`app/api/support/chat/queue/route.ts`), and hanging it off
 * a beat that fires every 30s per agent would multiply the writes by the number
 * of people looking at the screen.
 */

const AGENTS_TABLE = 'employee_support_chat_agents';
const SESSIONS_TABLE = 'employee_support_chat_sessions';

/** The feature key from the `employee_support` catalog (`feature-permissions.ts:121`). */
const SUPPORT_CHAT_FEATURE = 'support_chat';

/**
 * The statuses that mean an agent is currently holding a conversation. Not the
 * three OPEN statuses: a `waiting` session has no holder, so including it would
 * be reading `claimed_by` from rows where it is NULL by constraint.
 */
const ENGAGED_STATUSES = ['claimed', 'live'] as const satisfies readonly ChatSessionStatus[];

const AGENT_SELECT = 'agent_email, agent_name, on_queue, on_queue_since, last_heartbeat_at';

/** Everything this route says about the CALLER. `null` fields mean unknown. */
type MeWire = {
  email: string;
  /** `null` means the agents table could not be read — NOT "off the queue". */
  on_queue: boolean | null;
  on_queue_since: string | null;
  last_heartbeat_at: string | null;
  /**
   * Declared on, but the beat has gone quiet — so the queue is not offering
   * them anybody. The agent needs to be told this outright: the toggle still
   * looks on, and without this they would sit watching an empty board
   * believing they were available.
   */
  stale: boolean;
};

const UNKNOWN_AVAILABILITY: ChatAvailability = { state: 'unknown', onQueue: null, free: null };

/**
 * Gate + client. The READ takes `view`; both WRITES take `edit`.
 *
 * Same divergence from `app/api/tickets/[id]/comments/route.ts:43-46` as the
 * rest of this feature, and it matters most here: declaring yourself available
 * to answer pay disputes is the act the `employee_support` grant exists to
 * confer. Granting the role auto-provisions `edit`
 * (`provisionDashboardTabs`), so the five answerers are unaffected.
 */
async function prepare(
  level: 'view' | 'edit',
): Promise<{ ok: true; authz: AuthzOk; sb: SupabaseClient } | { ok: false; response: NextResponse }> {
  const authz = await requireFeatureAccessAnyView(SUPPORT_CHAT_FEATURE, level);
  if (!authz.ok) return { ok: false, response: deniedResponse(authz) };

  const sb = createSupabaseServiceRoleClient();
  if (!sb) {
    // No `migrated` here: nothing has asked the database anything yet, so
    // nothing may claim an answer about whether the migration ran.
    return {
      ok: false,
      response: NextResponse.json({ error: 'Support chat is unavailable right now.' }, { status: 503 }),
    };
  }
  return { ok: true, authz, sb };
}

/**
 * Every agent row. `null` when the read failed, which `availability.ts` reads
 * as UNKNOWN and never as "nobody is on".
 *
 * Paged even though this table holds one row per named agent and Kane granted
 * five: `selectAllPaged` costs exactly one request below 1000 rows, so the
 * safety is free (`select-all-paged.ts:4-11`).
 */
async function readAgents(
  sb: SupabaseClient,
): Promise<{ rows: ChatAgentRow[] | null; migrated: boolean }> {
  const { rows, error } = await selectAllPaged<ChatAgentRow>((from, to) =>
    sb.from(AGENTS_TABLE).select(AGENT_SELECT).order('agent_email', { ascending: true }).range(from, to),
  );
  if (error) {
    if (classifyTableProbe({ message: error }) === 'MISSING') return { rows: null, migrated: false };
    return { rows: null, migrated: true };
  }
  return { rows, migrated: true };
}

/**
 * The `claimed_by` of every session currently in a conversation. `null` when
 * the read failed — which `summarizeChatAvailability` turns into `unknown` with
 * the on-queue count intact, rather than a guess in either direction.
 */
async function readEngaged(sb: SupabaseClient): Promise<(string | null)[] | null> {
  const { rows, error } = await selectAllPaged<{ claimed_by: string | null }>((from, to) =>
    sb
      .from(SESSIONS_TABLE)
      .select('claimed_by')
      .in('status', [...ENGAGED_STATUSES])
      .order('claimed_by', { ascending: true })
      .range(from, to),
  );
  return error ? null : rows.map((r) => r.claimed_by);
}

/** The caller's own row, as the wire describes it. */
function meWire(email: string, agents: ChatAgentRow[] | null, now: Date): MeWire {
  if (!agents) {
    return { email, on_queue: null, on_queue_since: null, last_heartbeat_at: null, stale: false };
  }
  const key = normEmail(email);
  const row = agents.find((a) => normEmail(a.agent_email) === key) ?? null;
  if (!row) {
    return { email, on_queue: false, on_queue_since: null, last_heartbeat_at: null, stale: false };
  }
  const age = agentHeartbeatAgeMs(row, now);
  return {
    email,
    on_queue: !!row.on_queue,
    on_queue_since: row.on_queue_since ?? null,
    last_heartbeat_at: row.last_heartbeat_at ?? null,
    // Declared on, and the evidence has run out. `isAgentOnQueue` is the one
    // definition of that boundary; this is its negation, never a second
    // comparison against `AGENT_STALE_AFTER_MS` written out here.
    stale: !!row.on_queue && !isAgentOnQueue(row, now),
  };
}

/** The whole answer, shared by every verb so they cannot describe two worlds. */
async function describe(
  sb: SupabaseClient,
  email: string,
): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; migrated: false }
> {
  const agents = await readAgents(sb);
  if (!agents.migrated) return { ok: false, migrated: false };

  const now = new Date();
  const engaged = await readEngaged(sb);

  return {
    ok: true,
    body: {
      migrated: true,
      me: meWire(email, agents.rows, now),
      availability: summarizeChatAvailability({ agents: agents.rows, engaged, now }),
      // The cadence is SERVER-supplied so the browser cannot beat on a
      // different clock than the one staleness is judged against.
      heartbeat_ms: AGENT_HEARTBEAT_MS,
      stale_after_ms: AGENT_STALE_AFTER_MS,
      error: null,
    },
  };
}

const notMigrated = (email: string) =>
  NextResponse.json({
    migrated: false,
    me: { email, on_queue: null, on_queue_since: null, last_heartbeat_at: null, stale: false },
    availability: UNKNOWN_AVAILABILITY,
    heartbeat_ms: AGENT_HEARTBEAT_MS,
    stale_after_ms: AGENT_STALE_AFTER_MS,
    error: null,
  });

/* ───────────────────────────────── GET ──────────────────────────────────── */

/** GET — am I on the queue, and who else is? */
export async function GET() {
  const prepared = await prepare('view');
  if (!prepared.ok) return prepared.response;
  const { authz, sb } = prepared;

  const described = await describe(sb, authz.sessionEmail);
  if (!described.ok) return notMigrated(authz.sessionEmail);
  return NextResponse.json(described.body);
}

/* ──────────────────────────────── PATCH ─────────────────────────────────── */

/**
 * PATCH — declare, or undeclare.
 *
 * `{ on_queue: true }` is the only thing that ever writes `on_queue_since`, and
 * it writes it only on a genuine off→on transition: the guarded beat runs
 * first, and a row coming back means the agent was already on and their
 * "on the queue since 9:04" must survive (SQL `:317-319`).
 *
 * `{ on_queue: false }` clears BOTH stamps in the one UPDATE. The two
 * both-or-neither CHECKs (`:328-331`) reject a toggled-off row that still
 * carries either, and a lingering `on_queue_since` would read as "available
 * since this morning" to anything that forgot to check the boolean.
 */
export async function PATCH(request: Request) {
  const prepared = await prepare('edit');
  if (!prepared.ok) return prepared.response;
  const { authz, sb } = prepared;

  let payload: { on_queue?: unknown };
  try {
    payload = ((await request.json()) as { on_queue?: unknown }) ?? {};
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  if (typeof payload.on_queue !== 'boolean') {
    return NextResponse.json(
      { error: 'Send { "on_queue": true } or { "on_queue": false }. Nothing was changed.' },
      { status: 400 },
    );
  }

  // The row is keyed on the SESSION, never on anything the body said.
  const agent = normEmail(authz.sessionEmail);
  if (!agent) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const wantOn = payload.on_queue;
  const nowIso = new Date().toISOString();

  if (!wantOn) {
    const { error } = await sb
      .from(AGENTS_TABLE)
      .update({ on_queue: false, on_queue_since: null, last_heartbeat_at: null })
      .eq('agent_email', agent);
    if (error) {
      if (classifyTableProbe(error) === 'MISSING') return notMigrated(authz.sessionEmail);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    // Zero rows is SUCCESS, not a 404: an agent with no row is already not on
    // the queue, and the request asked for exactly that state.
    void insertAuditLog({
      ...auditFrom(request, authz),
      action: 'employee_support.chat.off_queue',
      resource: AGENTS_TABLE,
      resource_id: agent,
      details: { on_queue: false },
    });
  } else {
    // Step 1 — the guarded beat. A row back means they were already on, so
    // `on_queue_since` is left exactly where it was.
    const beat = await sb
      .from(AGENTS_TABLE)
      .update({ last_heartbeat_at: nowIso })
      .eq('agent_email', agent)
      .eq('on_queue', true)
      .select('agent_email');
    if (beat.error) {
      if (classifyTableProbe(beat.error) === 'MISSING') return notMigrated(authz.sessionEmail);
      return NextResponse.json({ error: beat.error.message }, { status: 500 });
    }

    if (!beat.data || beat.data.length === 0) {
      // Step 2 — a genuine off→on transition (or the agent's first ever
      // declaration). The name is looked up here and not on the beat path: it
      // is display text, and re-reading it 120 times an hour would be a lookup
      // per heartbeat for a string that changes when somebody gets married.
      const agentName = await lookupFullNameForEmail(authz.sessionEmail);
      const { error } = await sb.from(AGENTS_TABLE).upsert(
        {
          agent_email: agent,
          agent_name: agentName,
          on_queue: true,
          on_queue_since: nowIso,
          last_heartbeat_at: nowIso,
        },
        { onConflict: 'agent_email' },
      );
      if (error) {
        if (classifyTableProbe(error) === 'MISSING') return notMigrated(authz.sessionEmail);
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      void insertAuditLog({
        ...auditFrom(request, authz),
        action: 'employee_support.chat.on_queue',
        resource: AGENTS_TABLE,
        resource_id: agent,
        details: { on_queue: true },
      });
    }
  }

  const described = await describe(sb, authz.sessionEmail);
  if (!described.ok) return notMigrated(authz.sessionEmail);
  return NextResponse.json(described.body);
}

/* ──────────────────────────────── POST ──────────────────────────────────── */

/**
 * POST — the heartbeat. No body, and no power to create anything.
 *
 * **A GUARDED UPDATE, NEVER AN UPSERT.** `WHERE agent_email = <me> AND
 * on_queue` — a beat from a tab that has not noticed the agent toggled off in
 * another one must not put them back on the queue. Zero rows back is a 409
 * carrying the current state, which is the browser's signal to stop beating
 * and re-render the toggle rather than to retry.
 *
 * The beat never touches `on_queue_since`: that is what "on the queue since
 * 9:04" is read from, and it survives every beat by design (SQL `:317-319`).
 */
export async function POST(request: Request) {
  const prepared = await prepare('edit');
  if (!prepared.ok) return prepared.response;
  const { authz, sb } = prepared;

  const agent = normEmail(authz.sessionEmail);
  if (!agent) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { data, error } = await sb
    .from(AGENTS_TABLE)
    .update({ last_heartbeat_at: new Date().toISOString() })
    .eq('agent_email', agent)
    .eq('on_queue', true)
    .select('agent_email');

  if (error) {
    if (classifyTableProbe(error) === 'MISSING') return notMigrated(authz.sessionEmail);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const beat = !!data && data.length > 0;
  const described = await describe(sb, authz.sessionEmail);
  if (!described.ok) return notMigrated(authz.sessionEmail);

  if (!beat) {
    return NextResponse.json(
      {
        ...described.body,
        error: 'You are not on the queue, so nothing was recorded. Toggle on to start taking chats.',
      },
      { status: 409 },
    );
  }

  return NextResponse.json(described.body);
}
