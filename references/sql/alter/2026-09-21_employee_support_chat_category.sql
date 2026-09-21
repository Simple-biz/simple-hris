-- Migration: employee_support_chat_sessions — what the chat is ABOUT
--
-- Plan: docs/superpowers/plans/2026-09-21-employee-support-tickets-board.md
--       (the second block-quoted 2026-09-21 ruling).
-- Applied by: scripts/apply-employee-support-chat-migration.mts (--dry / --apply / --verify).
-- No BEGIN/COMMIT here — the apply script owns the transaction.
--
-- WHAT THIS IS FOR
-- ---------------------------------------------------------------------------
-- Kane, 2026-09-21: "The chat support option should ask the Employees what
-- issue is it about if it is about salary or COE or anything related to
-- Accounting and HR", and: "the support team should be able to click that chat
-- without reading it yet and see what the concern is about".
--
-- Both sentences need the same column. Today a waiting chat says WHO is
-- waiting and HOW LONG, and nothing at all about WHAT — so an agent cannot
-- choose what to pick up without opening the transcript, and a converted chat
-- is filed under 'other' because the session never knew its own subject
-- (src/lib/support/abandonment.ts, CHAT_TICKET_CATEGORY).
--
-- ONE VOCABULARY, NOT TWO
-- ---------------------------------------------------------------------------
-- The values are Carla's Decision 4 list, 2026-09-15 — exactly the nine on
-- public.employee_support_tickets.category
-- (references/sql/create/2026-09-16_employee_support.sql:68-81) and exactly
-- SUPPORT_CATEGORIES in src/lib/support/types.ts:27-37. Kane's two examples
-- land on it without a new value: salary -> 'pay_payslip',
-- COE -> 'documents_certificates'.
--
-- A second list would mean a mapping table between chat and ticket, and a
-- mapping is where the two drift. The ticket a chat becomes INHERITS this
-- column verbatim, which is only sound while both CHECKs admit the same nine.
--
-- Note what is still absent, deliberately: schedules and time-off. Carla ruled
-- those "a manager question", so there is no category to file them under here
-- either, and routing.ts steers instead.
--
-- WHY NULLABLE, AND WHY NOT `default 'other'`
-- ---------------------------------------------------------------------------
-- Every session that exists before this ships was never asked, and a NOT NULL
-- with no default would fail this ALTER outright on a non-empty table. So it is
-- one of the two, and the choice is not cosmetic:
--
--   NULL      — nobody asked. The session predates the picker, or arrived by a
--               path that does not collect one.
--   'other'   — the employee WAS asked and chose "Something else".
--
-- `default 'other'` would backfill every historical session with an answer
-- nobody gave (Postgres fills existing rows from the default), and from then on
-- the two facts would be spelled the same way. That is unrecoverable: you
-- cannot tell afterwards which rows were asked. NULL keeps them distinct, and
-- it matches how this table already spells a real state that has not happened
-- yet — claimed_by, ended_at, became_ticket_id are all nullable for the same
-- reason.
--
-- The 'other' FALLBACK still exists; it just lives at the boundary where it is
-- needed. employee_support_tickets.category is NOT NULL, so the conversion
-- resolves NULL (or anything it does not recognise) to 'other' in code —
-- `chatTicketCategory` in src/lib/support/abandonment.ts, which is the single
-- guard standing between an unrecognised value and the ticket table's
-- category CHECK. A 500 there means the employee silently never gets their
-- ES- number, which is the one failure this whole conversion path exists to
-- prevent.
--
-- THE TRIGGER DOES NOT TOUCH THIS COLUMN, AND THAT IS ON PURPOSE
-- ---------------------------------------------------------------------------
-- employee_support_chat_sessions_normalize() lower-cases emails and turns
-- blank names into NULL (2026-09-19_employee_support_chat.sql:348-380). It is
-- not extended here: a category is a KEY chosen from a fixed list, not a label
-- somebody typed, so '  pay_payslip  ' is not a near-miss to be tidied — it is
-- a caller writing something other than a SUPPORT_CATEGORY, and the CHECK below
-- refuses it loudly. Coercing it would hide the bug and would make this ALTER
-- rewrite a function that belongs to the create file.
--
-- RE-RUNNABILITY
-- ---------------------------------------------------------------------------
-- The column is added `if not exists` and the constraint only when absent.
-- NOTHING EXISTING IS DROPPED — the defect class this file is written against
-- is the FPU migration that dropped and re-added a status CHECK unconditionally
-- and would have stripped a value on a re-run (Open item 101). The CHECK covers
-- only the new column, so no existing row can violate it and ADD CONSTRAINT's
-- validating scan cannot fail on data already there.

alter table public.employee_support_chat_sessions
  add column if not exists category text;

comment on column public.employee_support_chat_sessions.category is
  'What the employee said the chat is about, asked when they join the queue. One of the nine SUPPORT_CATEGORIES (src/lib/support/types.ts) — the same vocabulary as employee_support_tickets.category, which the ticket a chat becomes inherits verbatim. NULL means nobody asked (a session from before the picker shipped), which is NOT the same fact as ''other'' (asked, and they said Something else). Never defaulted: a default would backfill history with an answer nobody gave.';

-- The nine, matching employee_support_tickets_category_valid exactly. NULL
-- passes: an un-asked session is a real state, not an invalid one.
do $category_valid$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.employee_support_chat_sessions'::regclass
       and conname  = 'employee_support_chat_sessions_category_valid'
  ) then
    alter table public.employee_support_chat_sessions
      add constraint employee_support_chat_sessions_category_valid
      check (
        category is null or category in (
          'pay_payslip',
          'bonus_pab',
          'hours_time_adjustment',
          'bank_payout',
          'documents_certificates',
          'gmail',
          'hubstaff',
          'roboform',
          'other'
        )
      );
    raise notice 'added employee_support_chat_sessions_category_valid';
  else
    raise notice 'employee_support_chat_sessions_category_valid already present — left alone';
  end if;
end
$category_valid$;

-- NO NEW INDEX, and that is a decision rather than an omission.
--
-- The staff queue reads the waiting line through
-- employee_support_chat_sessions_queue_idx — `(queued_at) where status =
-- 'waiting'` — and shows the category as a COLUMN on rows it was already
-- fetching. Nothing filters or groups on it in this build: agent
-- specialisation ("anything related to Accounting and HR" — who answers, not
-- what it is about) is the thing Kane deferred to his Carla meeting, and Q4
-- answers one global queue where every agent is qualified for everything.
--
-- An index for a filter nobody applies costs a write on every heartbeat-driven
-- UPDATE of this table and buys nothing. When the routing meeting happens and
-- the line is filtered by category, the index goes in with it.
