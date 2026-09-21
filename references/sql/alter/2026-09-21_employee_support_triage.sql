-- Migration: employee_support_tickets — triage (the queueing line and the board)
--
-- Plan: docs/superpowers/plans/2026-09-21-employee-support-tickets-board.md (task 1).
-- Applied by: scripts/apply-employee-support-triage-migration.mts (--dry / --apply / --verify).
-- No BEGIN/COMMIT here — the apply script owns the transaction.
--
-- WHAT THIS IS FOR
-- ---------------------------------------------------------------------------
-- Kane, 2026-09-18: "There should be a queing line then they rank it by urgency
-- which goes up to the board", and "the people who can access the tickets tab
-- can designate a ticket to its urgency ... they can rank it."
--
-- Ranking IS the promotion. There is no third thing that happens between the
-- line and the board, so there is no separate stage column:
--
--     in the queueing line  <->  priority is null
--     on the board          <->  priority is not null
--
-- A stored `triage_state` would be a SECOND status axis on a table that already
-- has one, and somebody would then have to answer "can a closed ticket be in
-- the line?". A derived line never has to.
--
-- WHY `priority` IS NULLABLE HERE AND NOT ON THE DEV BOARD
-- ---------------------------------------------------------------------------
-- `public.tickets.priority` is `not null default 'medium'`
-- (references/sql/migrate/2026-07-15_tickets_kanban.sql:48-49). This column is a
-- SUPERSET of that: the four VALUES are shared with TICKET_PRIORITIES
-- (src/lib/tickets/types.ts:33) so the two boards speak one language, but the
-- COLUMN is not the same and must not be made to match.
--
--   >> DO NOT widen TICKET_PRIORITIES or TICKET_PRIORITY_LABELS to admit a null
--   >> or a fifth 'none' value. That is a shared Record the dev board depends
--   >> on, and loosening it to make an unrelated feature compile is the exact
--   >> trade this codebase refuses. The support side carries its own
--   >> nullability, in its own module.
--
-- THE PROVENANCE COLUMNS ARE NOT DECORATION
-- ---------------------------------------------------------------------------
-- A bare `priority` records WHAT was decided and nothing about WHO or WHEN.
-- Kane deferred response-time KPIs ("lets not implement it now but sooner we
-- would have a ticket Response time and KPI Records") — and filed->triaged is
-- precisely the leg that measures the starvation risk the line creates. The
-- stamps cost nothing now and cannot be backfilled later.
--
-- RE-RUNNABILITY
-- ---------------------------------------------------------------------------
-- Every column is added `if not exists` and every constraint is added only when
-- absent. NOTHING EXISTING IS DROPPED. That is deliberate and it is the defect
-- class this file is written against: the FPU classes migration once dropped and
-- re-added a status CHECK unconditionally and would have stripped a value on a
-- re-run (docs/audits/audit-2026-09-16-session-log.md, Open item 101).
--
-- ONE existing object IS modified: the normalize trigger function is
-- CREATE OR REPLACEd so it lower-cases the new triaged_by column. Replace is not
-- drop — the trigger binding never detaches, and re-running re-declares the same
-- body. See the block at the end of this file for why the fix is there and not
-- in the verify control.
--
-- Both new CHECKs cover ONLY the new columns, so no existing row can violate
-- one and ADD CONSTRAINT's validating scan cannot fail on data already there.

alter table public.employee_support_tickets
  add column if not exists priority    text,
  add column if not exists triaged_at  timestamptz,
  add column if not exists triaged_by  text;

comment on column public.employee_support_tickets.priority is
  'NULL = still in the queueing line, un-triaged. Non-null = ranked onto the board. One of low/medium/high/urgent, the same four values as public.tickets.priority (TICKET_PRIORITIES) — shared vocabulary, separate column: this one is nullable and that one is not.';

comment on column public.employee_support_tickets.triaged_at is
  'When the ticket was ranked onto the board. Moves as a set with priority and triaged_by. Also the far end of the filed->triaged leg a response-time KPI will want later.';

comment on column public.employee_support_tickets.triaged_by is
  'Who ranked it. Lower-cased and trimmed by employee_support_tickets_normalize(), which this migration re-declares to cover the column — the shipped trigger predated it.';

-- The four values, matching TICKET_PRIORITIES exactly. NULL passes: an
-- un-triaged ticket is the default state, not an invalid one.
do $priority_valid$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.employee_support_tickets'::regclass
       and conname  = 'employee_support_tickets_priority_valid'
  ) then
    alter table public.employee_support_tickets
      add constraint employee_support_tickets_priority_valid
      check (priority is null or priority in ('low', 'medium', 'high', 'urgent'));
    raise notice 'added employee_support_tickets_priority_valid';
  else
    raise notice 'employee_support_tickets_priority_valid already present — left alone';
  end if;
end
$priority_valid$;

-- All three set, or all three null. Nothing in between is representable, so a
-- row can never claim it was ranked without saying by whom, and a demotion
-- cannot leave a stale stamp behind.
--
-- Demotion therefore FORGETS the rank and the audit log remembers it — the same
-- answer this feature gives for handoff history, for the same reason: the row
-- carries the current truth, `audit_log` carries how it got there.
do $triage_set$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.employee_support_tickets'::regclass
       and conname  = 'employee_support_tickets_triage_all_or_nothing'
  ) then
    alter table public.employee_support_tickets
      add constraint employee_support_tickets_triage_all_or_nothing
      check (
        (priority is null and triaged_at is null and triaged_by is null)
        or (priority is not null and triaged_at is not null and triaged_by is not null)
      );
    raise notice 'added employee_support_tickets_triage_all_or_nothing';
  else
    raise notice 'employee_support_tickets_triage_all_or_nothing already present — left alone';
  end if;
end
$triage_set$;

-- THE NORMALIZE TRIGGER LEARNS THE NEW COLUMN.
--
-- The shipped trigger function lower-cases and trims every email column on this
-- table — work_email, filed_by_email, claimed_by, closed_by — and it predates
-- triaged_by, so on its own it would let '  Carla@Simple.BIZ ' through as-is.
-- The first --verify against production caught exactly that (2026-09-21: "a
-- ranked ticket is accepted when all three move together — returned false"),
-- because this file's own comment had claimed the trigger covered it. It did not.
--
-- The fix is the trigger, NOT the control: every other email column here is
-- normalised at the row, so a route that forgot to lower-case would still write
-- a correct row, and a control weakened to pass would have hidden a real gap.
--
-- CREATE OR REPLACE is the one place this file touches something that already
-- exists. It is idempotent — re-running re-declares the same function — and it
-- REPLACES rather than drops, so the trigger binding stays attached throughout.
-- The body below is the shipped body from
-- references/sql/create/2026-09-16_employee_support.sql, line for line, plus
-- ONE line. If that create file ever changes this function, change it here too;
-- the --verify control for a mixed-case triaged_by is what tells you they drifted.

create or replace function public.employee_support_tickets_normalize()
returns trigger
language plpgsql
as $$
begin
  new.work_email     := lower(btrim(new.work_email));
  new.filed_by_email := lower(btrim(new.filed_by_email));
  new.claimed_by     := lower(nullif(btrim(coalesce(new.claimed_by, '')), ''));
  new.closed_by      := lower(nullif(btrim(coalesce(new.closed_by, '')), ''));
  new.triaged_by     := lower(nullif(btrim(coalesce(new.triaged_by, '')), ''));
  new.department     := nullif(btrim(coalesce(new.department, '')), '');
  new.updated_at     := now();
  return new;
end;
$$;

-- NO NEW INDEX, and that is a decision rather than an omission.
--
-- `employee_support_tickets_open_idx` is already
-- `(created_at) where status in ('open','claimed')` — the exact predicate both
-- stages sit inside, already ordered by filing time. The line scan and the
-- board scan both ride it, and the board's urgency ordering is applied in
-- TypeScript over a paged read because the open set is bounded by what five
-- people can hold open.
--
-- A generated `priority_rank smallint` would let PostgREST order the board
-- directly, and it was considered and declined: the sort rule is an assumption
-- carried on Kane's behalf, stated reversible, and baking a reversible policy
-- into a table-rewriting generated column whose expression cannot be altered in
-- place puts it in the hardest place to change. If the open set ever outgrows
-- one paged read, that column is the answer — and adding it is free while the
-- table is small and is not free later.
