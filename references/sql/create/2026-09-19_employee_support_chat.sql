-- Employee Support: LIVE CHAT. An employee opens a chat from inside /employee,
-- joins one global queue, and one of five named people picks up the next waiter
-- from a new section on /tickets. A chat nobody answers becomes an ES- ticket.
--
-- Approved by Kane 2026-09-19 (Q1-Q4). Plan:
-- docs/superpowers/plans/2026-09-19-employee-support-chat.md
--
-- This REVERSES a signed decision. Carla ticked Decision 2 on 2026-09-15
-- ("tickets first, add live chat once we know the volume"); Kane overrode it on
-- 2026-09-18 and reaffirmed on 2026-09-19. Carla has not been told. Recorded
-- here so chat-first is never rediscovered as drift.
--
-- DEPENDS ON references/sql/create/2026-09-16_employee_support.sql.
-- ---------------------------------------------------------------------------
-- `became_ticket_id` is a foreign key into public.employee_support_tickets, so
-- that table must exist before this file runs. Its live state is UNKNOWN, not
-- unapplied — nothing has been measured against production from this session —
-- which is why the guard below is an exception and not a comment: a missing
-- parent must stop the migration loudly, at the top, instead of failing three
-- hundred lines later with a bare "relation does not exist".
--
-- WHY THREE TABLES AND NOT A `kind` COLUMN ON THE TICKET TABLES
-- ---------------------------------------------------------------------------
-- A ticket is a record with a one-working-day promise; a chat session is a
-- position in a line with a heartbeat under it. They share a vocabulary and
-- almost no lifecycle: a ticket is never claimed-then-released-then-reclaimed,
-- and a chat has no category, no first_response_at and no closure actor. Folded
-- into one table, every CHECK would have to be written as "or the other kind",
-- which is the shape of a constraint that has stopped constraining. The join
-- that matters — an abandoned chat becoming a ticket — is one nullable FK.
--
-- THESE TABLES ARE DELIBERATELY *NOT* ADDED TO supabase_realtime.
-- ---------------------------------------------------------------------------
-- Do not add them. Same reasoning as the ticket tables
-- (2026-09-16_employee_support.sql:26-33), and here it is load-bearing twice
-- over: postgres_changes is dead for the anon browser on any RLS-guarded table,
-- so making it deliver would mean a permissive anon SELECT policy on a table
-- holding pay disputes typed in real time. The live signal this feature ships
-- carries the FACT that session N changed — never a message body — and every
-- client re-fetches through its own gated route. See
-- src/lib/support/chat-live.ts and the plan's Invariants.
--
-- THE THREE COLUMNS THAT ARE NOT WHAT THEY LOOK LIKE
-- ---------------------------------------------------------------------------
-- * `queued_at` is the employee's RANK, not an audit timestamp. It is stamped
--   once and is immutable by trigger. When an agent abandons a claim the
--   session returns to 'waiting' with its ORIGINAL queued_at, so the employee
--   goes back to the place they held and never pays for an agent's disconnect.
--   `created_at` is the audit timestamp; they are deliberately two columns.
-- * `last_seen_at` is the EMPLOYEE's heartbeat and it is how a closed browser
--   leaves the queue. Nothing sweeps it: expiry is decided on READ by comparing
--   it to now(), because every /api/cron/* route in this system 401s on a
--   fail-closed gate and the two declared crons have never once run
--   (docs/features/INDEX.md:42). A sweep that never runs is worse than no sweep.
-- * `status` is not derivable from the stamps and must not be inferred from
--   them. 'ended' and 'abandoned' both carry an ended_at; only the status says
--   which one happened, and only 'abandoned' becomes a ticket.

-- ===========================================================================
-- Precondition
-- ===========================================================================

do $precondition$
begin
  if to_regclass('public.employee_support_tickets') is null then
    raise exception
      'public.employee_support_tickets is missing. Run "scripts/Apply Employee Support migration.cmd" first — chat''s became_ticket_id foreign key has nothing to point at.';
  end if;
end
$precondition$;

-- ===========================================================================
-- Sessions — one row per conversation, from "I have a question" to ES-1043
-- ===========================================================================

create table if not exists public.employee_support_chat_sessions (
  id            uuid primary key default gen_random_uuid(),

  -- The human-facing number, its OWN series — the same reasoning as
  -- employee_support_tickets.ticket_no. A chat and a ticket are different
  -- objects and one shared series would make "43" ambiguous between them. A
  -- session that becomes a ticket therefore carries BOTH numbers, which is
  -- correct: they are two facts about it, not one fact written twice.
  session_no    bigint generated by default as identity,

  -- Identity, exactly as on the ticket table. `work_email` is the MASTER work
  -- email resolved server-side and is the key every other surface joins on;
  -- `filed_by_email` is the address the session actually carried, which can
  -- legitimately be a personal or alternate address. Both are kept because they
  -- answer different questions: who this is, and how they got here.
  --
  -- The ROUTE writes these from authz.effectiveEmail, never from the request
  -- body. The body is a request; the session is the answer.
  work_email      text not null,
  filed_by_email  text not null,
  member_name     text,
  -- Master-list Department cell as written, e.g. 'hsl:intake_specialist'.
  -- Stored RAW: this is a key, not a label (dept-label-display-sweep).
  department      text,

  -- Lifecycle. Mirrored by CHAT_SESSION_STATUSES in src/lib/support/chat-types.ts;
  -- the two must be changed together, and the test in that module is what keeps
  -- them agreeing.
  --
  --   waiting   — in the line, nobody has picked it up
  --   claimed   — an agent has taken it, the first word has not been said
  --   live      — the conversation is happening
  --   ended     — somebody closed it: answered, or the employee left
  --   abandoned — it expired unanswered; this is the one that becomes a ticket
  --
  -- There is no 'expired' separate from 'abandoned' and no 'transferred': a
  -- handoff is a compare-and-set on claimed_by and does not change the status.
  status        text not null default 'waiting',
  constraint employee_support_chat_sessions_status_valid
    check (status in ('waiting', 'claimed', 'live', 'ended', 'abandoned')),

  -- RANK, not an audit stamp. See the header. Immutable by trigger.
  queued_at     timestamptz not null default now(),

  -- Claiming is a compare-and-set: UPDATE ... WHERE claimed_by IS NULL. Two
  -- agents cannot both take the same waiter; the loser gets zero rows back and
  -- the route answers 409 with copy that says nothing was recorded. The handoff
  -- is the OTHER compare-and-set — WHERE claimed_by = <the current holder> —
  -- and the two are never collapsed into one loosened UPDATE.
  claimed_by    text,
  claimed_at    timestamptz,

  -- Stamped when the session leaves the live states, by 'ended' or 'abandoned'
  -- alike. Which of the two happened is `status`, never an inference from here.
  ended_at      timestamptz,

  -- The EMPLOYEE's heartbeat. Read-time staleness, never a sweep. See header.
  last_seen_at  timestamptz not null default now(),

  -- Q1: an unanswered chat BECOMES a ticket. The conversion is the lazy sweep's
  -- only write, and these two columns are its receipt.
  --
  -- ON DELETE RESTRICT, not SET NULL: the ticket is the permanent record this
  -- chat turned into, and a chat pointing at a deleted ticket is a lie about
  -- what happened to the employee's question. Nothing in the application deletes
  -- a support ticket, so this refuses an act that should never occur rather than
  -- quietly rewriting history when it does.
  became_ticket_id  uuid references public.employee_support_tickets (id)
                    on delete restrict,
  became_ticket_at  timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- ---- Both-or-neither: every paired column moves as one act ----
  -- Claiming is one act, so both columns move together.
  constraint employee_support_chat_sessions_claim_both_or_neither
    check ((claimed_at is null) = (claimed_by is null)),
  -- Becoming a ticket is one act. Half of it is not a state.
  constraint employee_support_chat_sessions_became_both_or_neither
    check ((became_ticket_id is null) = (became_ticket_at is null)),

  -- ---- The status must agree with the stamps ----
  -- A claimed or live session must name its agent, or "claimed" means nothing.
  constraint employee_support_chat_sessions_claimed_has_owner
    check (status not in ('claimed', 'live') or claimed_by is not null),
  -- A WAITING session is unclaimed — this is the DB backstop for the release
  -- path. An abandoned claim must clear BOTH claim columns on its way back to
  -- the line; a release that forgets one leaves a waiter nobody can take.
  constraint employee_support_chat_sessions_waiting_is_unclaimed
    check (status <> 'waiting' or claimed_by is null),
  -- An ended or abandoned session carries the stamp that says when.
  constraint employee_support_chat_sessions_ended_has_stamp
    check (status not in ('ended', 'abandoned') or ended_at is not null),
  -- Only an abandoned session becomes a ticket. An answered conversation does
  -- not need an ES- number, and a session still in the line has not finished
  -- happening. The reverse is NOT asserted: 'abandoned' with no ticket yet is
  -- the legitimate instant between the status flip and the conversion.
  constraint employee_support_chat_sessions_only_abandoned_becomes_ticket
    check (became_ticket_id is null or status = 'abandoned'),

  -- ---- Presence guards ----
  constraint employee_support_chat_sessions_work_email_present
    check (length(btrim(work_email)) > 0),
  constraint employee_support_chat_sessions_filed_by_present
    check (length(btrim(filed_by_email)) > 0)
);

comment on table public.employee_support_chat_sessions is
  'Employee Support live chat sessions: one row per conversation, queued_at is the rank. Answered from /tickets by the employee_support role. Service-role only; deliberately NOT in supabase_realtime.';

create unique index if not exists employee_support_chat_sessions_no_uniq
  on public.employee_support_chat_sessions (session_no);

-- ONE open session per employee. The route checks first and answers politely;
-- this is the backstop that makes the check true under a double submit, because
-- a check-then-insert in application code is a race and this is not.
--
-- Partial on the three OPEN statuses: an employee who has ended a chat may open
-- another one, and a year of ended sessions must not block them.
create unique index if not exists employee_support_chat_sessions_one_open_per_employee
  on public.employee_support_chat_sessions (lower(work_email))
  where status in ('waiting', 'claimed', 'live');

-- THE QUEUE. Position is a COUNT over this set, ordered by rank. Note what is
-- absent: a position column. A stored position is wrong the moment anybody
-- leaves the line, and the route counts instead — through selectAllPaged,
-- because PostgREST caps a result set at 1000 rows with no error and an unpaged
-- count yields a confidently wrong position.
create index if not exists employee_support_chat_sessions_queue_idx
  on public.employee_support_chat_sessions (queued_at)
  where status = 'waiting';

-- The agent's own live list.
create index if not exists employee_support_chat_sessions_agent_idx
  on public.employee_support_chat_sessions (claimed_by, queued_at)
  where claimed_by is not null;

-- The employee side always reads "my chats, newest first".
create index if not exists employee_support_chat_sessions_mine_idx
  on public.employee_support_chat_sessions (lower(work_email), queued_at desc);

-- The lazy expiry sweep's scan: the open sessions whose heartbeat has gone
-- quiet. Scoped to the open statuses so it never walks the history.
create index if not exists employee_support_chat_sessions_stale_idx
  on public.employee_support_chat_sessions (last_seen_at)
  where status in ('waiting', 'claimed', 'live');

-- ===========================================================================
-- Messages — immutable, three author sides
-- ===========================================================================

create table if not exists public.employee_support_chat_messages (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null
                references public.employee_support_chat_sessions (id) on delete cascade,

  -- Which side of the conversation. Not derived from whether the author holds
  -- the employee_support role at read time: grants are revoked, and a reply must
  -- still read as an agent a year later.
  --
  -- 'system' is the third side the ticket table does not have, and it is why
  -- author_email is nullable here and NOT NULL there. "Carla joined", "the
  -- employee left", "this conversation became ES-1043" are written by nobody,
  -- and attributing them to the agent who happened to trigger them would put
  -- words in a named person's mouth inside a transcript that becomes a ticket.
  author_side   text not null,
  constraint employee_support_chat_messages_side_valid
    check (author_side in ('employee', 'agent', 'system')),

  author_email  text,
  author_name   text,
  body          text not null,

  -- MODERATION — the shipped screening.ts, unchanged, on the same terms as the
  -- ticket table: a flag NEVER blocks. Screening runs, records what it found,
  -- and the message is delivered regardless. A false positive on a blocking
  -- screen silences an employee with a real complaint, on the one channel the
  -- company built for complaints — and in a chat it would do so mid-sentence.
  flagged_at    timestamptz,
  flag_reason   text,

  -- Immutable once posted, exactly like employee_support_messages. No
  -- updated_at, and no edit or delete path: this transcript IS the content of
  -- the ticket an abandoned chat becomes, and an editable record answers a
  -- different question than this one.
  created_at    timestamptz not null default now(),

  -- A human message names its author; a system line has no author to name.
  -- Both-or-neither against the side, so neither half can drift.
  constraint employee_support_chat_messages_author_matches_side
    check ((author_side = 'system') = (author_email is null)),
  constraint employee_support_chat_messages_flag_both_or_neither
    check ((flagged_at is null) = (flag_reason is null)),
  constraint employee_support_chat_messages_body_present
    check (length(btrim(body)) > 0),
  -- Matches the clamp the route applies. The DB is the backstop, not the
  -- validator. Same 4000 as the ticket side so a transcript can be carried into
  -- a ticket without a message becoming illegal on the way.
  constraint employee_support_chat_messages_body_bounded
    check (length(body) <= 4000)
);

comment on table public.employee_support_chat_messages is
  'Messages on an Employee Support live chat. Immutable once posted; the transcript is the content of the ticket an abandoned chat becomes. Service-role only; deliberately NOT in supabase_realtime.';

create index if not exists employee_support_chat_messages_thread_idx
  on public.employee_support_chat_messages (session_id, created_at);

create index if not exists employee_support_chat_messages_flagged_idx
  on public.employee_support_chat_messages (flagged_at desc)
  where flagged_at is not null;

-- ===========================================================================
-- Agents — the explicit "I'm on the queue" toggle (Q4)
-- ===========================================================================
-- NOT ENUMERATED IN THE PLAN'S TASK 1, which names two tables. It is added here
-- because plan task 13 (the on-queue toggle and its heartbeat) and task 6
-- (`agentsOnQueue` derived from stamps, NEVER from presence) have nowhere else
-- to live. The alternatives were both worse: user_presence is the thing the
-- plan's invariant forbids — and its heartbeat route takes the email from the
-- REQUEST BODY when there is no session (SECURITY_AUDIT.md:245 row #50), so it
-- cannot gate a queue — and app_settings is a key/value store that would make
-- "how many agents are on the queue" a string-prefix scan.
--
-- WHY A TOGGLE AND A HEARTBEAT ARE TWO COLUMNS AND NOT ONE
-- `on_queue` is a DECLARATION: the agent said they are available. The heartbeat
-- is EVIDENCE: their browser is still open. An agent who toggled on and then
-- closed their laptop is declared-on and stale, and read-time staleness — not a
-- sweep, not a cron — is what stops the queue offering them the next waiter.
-- Collapsing the two would mean a missed beat silently un-declares them, and
-- they would have to keep re-toggling all day.

create table if not exists public.employee_support_chat_agents (
  -- One row per agent, keyed by their work email. Lowercased by trigger, so the
  -- primary key is the identity and there is no second "which casing" question.
  agent_email       text primary key,
  agent_name        text,

  -- The declaration.
  on_queue          boolean not null default false,
  -- When they declared it. Not the same as the heartbeat: this is what "on the
  -- queue since 9:04" is read from, and it survives every beat.
  on_queue_since    timestamptz,
  -- The evidence. Rewritten by every beat; compared to now() on READ.
  last_heartbeat_at timestamptz,

  updated_at        timestamptz not null default now(),

  -- Both-or-neither, tied to the declaration: off the queue means both stamps
  -- are cleared. A lingering on_queue_since on a toggled-off agent would read as
  -- "available since this morning" to anything that forgot to check the boolean.
  constraint employee_support_chat_agents_since_matches_toggle
    check (on_queue = (on_queue_since is not null)),
  constraint employee_support_chat_agents_beat_matches_toggle
    check (on_queue = (last_heartbeat_at is not null)),
  constraint employee_support_chat_agents_email_present
    check (length(btrim(agent_email)) > 0)
);

comment on table public.employee_support_chat_agents is
  'Employee Support live chat availability: the explicit on-queue toggle plus the heartbeat that proves the browser is still open. Staleness is decided on read, never swept. Service-role only; deliberately NOT in supabase_realtime.';

-- "Who can take the next waiter" — the only read this table has.
create index if not exists employee_support_chat_agents_on_queue_idx
  on public.employee_support_chat_agents (last_heartbeat_at desc)
  where on_queue;

-- ===========================================================================
-- Normalising triggers
-- ===========================================================================

create or replace function public.employee_support_chat_sessions_normalize()
returns trigger
language plpgsql
as $$
begin
  -- A POSITION NEVER RISES. queued_at is the employee's rank, and the release
  -- path (an abandoned claim returning them to the line) must put them back
  -- where they were. This RAISES rather than silently restoring the old value:
  -- an UPDATE that tried to move somebody's place in the line is a bug in a
  -- route, and a bug that is quietly corrected here is a bug nobody fixes.
  --
  -- NESTED, not `tg_op = 'UPDATE' and ...`: PL/pgSQL evaluates an IF condition
  -- as one SQL expression and SQL's AND does not promise to short-circuit, so
  -- the one-line form can reach OLD on an INSERT — where OLD is unassigned and
  -- the reference itself is the error.
  if tg_op = 'UPDATE' then
    if new.queued_at is distinct from old.queued_at then
      raise exception
        'employee_support_chat_sessions.queued_at is immutable (session %): a position never rises. Re-entering the line is a NEW session row.',
        old.session_no;
    end if;
  end if;

  new.work_email     := lower(btrim(new.work_email));
  new.filed_by_email := lower(btrim(new.filed_by_email));
  new.claimed_by     := lower(nullif(btrim(coalesce(new.claimed_by, '')), ''));
  new.member_name    := nullif(btrim(coalesce(new.member_name, '')), '');
  new.department     := nullif(btrim(coalesce(new.department, '')), '');
  new.updated_at     := now();

  return new;
end;
$$;

drop trigger if exists employee_support_chat_sessions_normalize_trg
  on public.employee_support_chat_sessions;
create trigger employee_support_chat_sessions_normalize_trg
  before insert or update on public.employee_support_chat_sessions
  for each row execute function public.employee_support_chat_sessions_normalize();

create or replace function public.employee_support_chat_messages_normalize()
returns trigger
language plpgsql
as $$
begin
  -- A blank author email becomes NULL, which the side CHECK then rejects for an
  -- employee or agent message. '  ' is not an author.
  new.author_email := lower(nullif(btrim(coalesce(new.author_email, '')), ''));
  new.author_name  := nullif(btrim(coalesce(new.author_name, '')), '');
  return new;
end;
$$;

drop trigger if exists employee_support_chat_messages_normalize_trg
  on public.employee_support_chat_messages;
create trigger employee_support_chat_messages_normalize_trg
  before insert on public.employee_support_chat_messages
  for each row execute function public.employee_support_chat_messages_normalize();

create or replace function public.employee_support_chat_agents_normalize()
returns trigger
language plpgsql
as $$
begin
  new.agent_email := lower(btrim(new.agent_email));
  new.agent_name  := nullif(btrim(coalesce(new.agent_name, '')), '');
  new.updated_at  := now();
  return new;
end;
$$;

drop trigger if exists employee_support_chat_agents_normalize_trg
  on public.employee_support_chat_agents;
create trigger employee_support_chat_agents_normalize_trg
  before insert or update on public.employee_support_chat_agents
  for each row execute function public.employee_support_chat_agents_normalize();

-- ===========================================================================
-- RLS: on, with no policies
-- ===========================================================================
-- Every read and write goes through a gated route holding the service-role key.
-- No policy is the point: with RLS enabled and nothing granted, the anon key
-- reads nothing at all. This is the house pattern, and on a table holding a
-- live transcript of a pay dispute it is also the reason the feature is allowed
-- to exist on this data.

alter table public.employee_support_chat_sessions enable row level security;
alter table public.employee_support_chat_messages enable row level security;
alter table public.employee_support_chat_agents   enable row level security;
