-- Accounting Scoreboard round 3 — Carla's "SCOREBOARD UPDATES" email (2026-10-02), built 2026-10-06.
--
-- Governing doc: docs/features/accounting-scoreboard.md
-- Base tables:   references/sql/create/2026-10-01_accounting_scoreboard.sql (applied 2026-10-01)
--
--   1. Buckets: a weekday Collections bucket ("Mon (Collections)" …) is marked with the day it is
--      worked (rows.bucket_day). Its score is Pending until that day's PM reading is in.
--   2. Collections: "Payment Verified" lives in its OWN table. The collections log stays append-only:
--      no column is added to it and its trigger is untouched.
--   3. PM Buckets: the No Meeting Streak is computed from the meeting ticks. Nothing is stored.
--   4. Chargebacks: Open Disputes keeps its AM/PM grid, and a row can be flagged "due in 7 days"
--      (rows.due_soon). Outcomes (Pre-arb, Wins, Losses) is a new section, `chargeback_outcomes`,
--      with a dollar amount (`usd`) and a count (`count`) per day.
--   5. Payroll Problems: a log of problems, each with a type. Types are a list managers add to.
--   6. Setup: managers create custom sections. Their rows are section_key 'custom'.
--
-- NOTHING HERE PAYS ANYONE (Open item 315 is unchanged). Service-role only, like every scoreboard
-- table: RLS on with NO policies, privileges revoked from anon/authenticated, nothing in
-- supabase_realtime, trigger functions revoked from PUBLIC/anon/authenticated.
--
-- The section keys and slots below are pinned to src/lib/accounting-scoreboard/sections.ts by
-- sections.test.ts, which reads THIS file for the current CHECK lists.
--
-- Re-runnable: every DDL is IF NOT EXISTS / DROP … IF EXISTS + ADD, and every data step is guarded
-- so a second run changes nothing.

-- ===========================================================================
-- Custom sections (Setup → Sections → New section)
-- ===========================================================================
-- Built-in sections stay code (sections.ts). A custom section is a manager's own: a title, one of
-- two kinds, and an optional goal. Archived, never deleted: its rows and numbers are kept.

create table if not exists public.accounting_scoreboard_custom_sections (
  id              uuid primary key default gen_random_uuid(),

  title           text not null,
  constraint acct_sb_custom_title_valid
    check (length(btrim(title)) between 1 and 60 and title = btrim(title)),

  -- daily = one number a day (headline: the week's total)
  -- am_pm = a reading at the start and end of each day, scored like Accounting Buckets
  kind            text not null,
  constraint acct_sb_custom_kind_valid check (kind in ('daily', 'am_pm')),

  goal            numeric(10, 2),
  goal_direction  text,
  constraint acct_sb_custom_goal_range check (goal is null or (goal >= 0 and goal <= 100000)),
  constraint acct_sb_custom_goal_direction_valid check (goal_direction is null or goal_direction in ('at_least', 'below')),
  constraint acct_sb_custom_goal_pair check ((goal is null) = (goal_direction is null)),
  -- An AM/PM section is scored 0–10, so its goal is a score to reach, never a ceiling.
  constraint acct_sb_custom_score_goal_at_least check (kind <> 'am_pm' or goal_direction is distinct from 'below'),
  constraint acct_sb_custom_score_goal_max check (kind <> 'am_pm' or goal is null or goal <= 10),

  enabled         boolean not null default true,
  sort_order      integer not null default 0,

  created_at      timestamptz not null default now(),
  created_by      text not null,
  constraint acct_sb_custom_created_by_present check (length(btrim(created_by)) > 0),
  updated_at      timestamptz not null default now(),
  updated_by      text not null,
  constraint acct_sb_custom_updated_by_present check (length(btrim(updated_by)) > 0),

  archived_at     timestamptz,
  archived_by     text,
  constraint acct_sb_custom_archive_pair check ((archived_at is null) = (archived_by is null))
);

create unique index if not exists acct_sb_custom_one_live_title
  on public.accounting_scoreboard_custom_sections (lower(title)) where archived_at is null;

comment on table public.accounting_scoreboard_custom_sections is
  'Accounting Scoreboard custom sections, created by managers in Setup. Archived, never deleted. Service-role only.';

-- ===========================================================================
-- Rows: the new sections, a custom section's rows, and two row flags
-- ===========================================================================

alter table public.accounting_scoreboard_rows drop constraint if exists acct_sb_rows_section_valid;
alter table public.accounting_scoreboard_rows add constraint acct_sb_rows_section_valid check (section_key in (
  'buckets', 'chargebacks', 'chargeback_outcomes', 'pm_buckets', 'collections', 'onboarding',
  'compliance', 'inbox', 'cancellations', 'payroll_timing', 'payroll_problems', 'custom'
));

-- A custom section's row names its section; every other row names none.
alter table public.accounting_scoreboard_rows
  add column if not exists custom_section_id uuid references public.accounting_scoreboard_custom_sections (id);
alter table public.accounting_scoreboard_rows drop constraint if exists acct_sb_rows_custom_pair;
alter table public.accounting_scoreboard_rows add constraint acct_sb_rows_custom_pair
  check ((section_key = 'custom') = (custom_section_id is not null));

-- The weekday a weekday Collections bucket is worked. Its score is Pending until that day's PM.
alter table public.accounting_scoreboard_rows add column if not exists bucket_day text;
alter table public.accounting_scoreboard_rows drop constraint if exists acct_sb_rows_bucket_day_valid;
alter table public.accounting_scoreboard_rows add constraint acct_sb_rows_bucket_day_valid check (
  bucket_day is null or (section_key = 'buckets' and bucket_day in ('mon', 'tue', 'wed', 'thu', 'fri'))
);

-- An Open Disputes row that counts the disputes due in the next 7 days: called out on the board.
alter table public.accounting_scoreboard_rows add column if not exists due_soon boolean not null default false;
alter table public.accounting_scoreboard_rows drop constraint if exists acct_sb_rows_due_soon_valid;
alter table public.accounting_scoreboard_rows add constraint acct_sb_rows_due_soon_valid
  check (not due_soon or section_key = 'chargebacks');

-- One live label and one live person per section — and, for custom rows, per custom section. For
-- every built-in section the coalesce is one constant, so its uniqueness is exactly what it was.
drop index if exists public.acct_sb_rows_one_live_label;
create unique index acct_sb_rows_one_live_label
  on public.accounting_scoreboard_rows
     (section_key, coalesce(custom_section_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(label))
  where archived_at is null;
drop index if exists public.acct_sb_rows_one_live_person;
create unique index acct_sb_rows_one_live_person
  on public.accounting_scoreboard_rows
     (section_key, coalesce(custom_section_id, '00000000-0000-0000-0000-000000000000'::uuid), work_email)
  where archived_at is null and work_email is not null;

-- ===========================================================================
-- Sections (switches): the new built-in section can be switched off too
-- ===========================================================================

alter table public.accounting_scoreboard_sections drop constraint if exists acct_sb_sections_key_valid;
alter table public.accounting_scoreboard_sections add constraint acct_sb_sections_key_valid check (section_key in (
  'buckets', 'chargebacks', 'chargeback_outcomes', 'pm_buckets', 'collections', 'onboarding',
  'compliance', 'inbox', 'cancellations', 'payroll_timing', 'payroll_problems'
));

-- ===========================================================================
-- Entries: Chargeback Outcomes' two numbers a day
-- ===========================================================================
--   usd   — the day's dollar amount (dollars and cents, under the table's 100,000 ceiling)
--   count — how many chargebacks: a whole number

alter table public.accounting_scoreboard_entries drop constraint if exists acct_sb_entries_slot_valid;
alter table public.accounting_scoreboard_entries add constraint acct_sb_entries_slot_valid
  check (slot in ('am', 'pm', 'day', 'mtg', 'start', 'end', 'usd', 'count'));
alter table public.accounting_scoreboard_entries drop constraint if exists acct_sb_entries_count_whole;
alter table public.accounting_scoreboard_entries add constraint acct_sb_entries_count_whole
  check (slot <> 'count' or value = trunc(value));

-- ===========================================================================
-- Collections: Payment Verified (its own table; the log is never edited)
-- ===========================================================================
-- One live verification per collection. Unchecking stamps the line (unverified_at/by) and never
-- deletes it, so who verified and who took it back are both kept. Checking again adds a new line.

create table if not exists public.accounting_scoreboard_collection_verifications (
  id                uuid primary key default gen_random_uuid(),
  collection_id     uuid not null references public.accounting_scoreboard_collections (id),

  verified_at       timestamptz not null default now(),
  verified_by       text not null,
  constraint acct_sb_verif_by_present check (length(btrim(verified_by)) > 0),
  -- The name printed beside the tick, resolved from the board's rows / the roster when it was checked.
  verified_by_name  text not null,
  constraint acct_sb_verif_name_valid check (length(btrim(verified_by_name)) between 1 and 120),

  unverified_at     timestamptz,
  unverified_by     text,
  constraint acct_sb_verif_unverify_pair check ((unverified_at is null) = (unverified_by is null))
);

create unique index if not exists acct_sb_verif_one_live
  on public.accounting_scoreboard_collection_verifications (collection_id) where unverified_at is null;

comment on table public.accounting_scoreboard_collection_verifications is
  'Accounting Scoreboard "Payment Verified" ticks. Append-only apart from the one uncheck stamp. Service-role only.';

create or replace function public.accounting_scoreboard_verifications_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.unverified_at is not null then
    raise exception 'acct_sb_verif_unchecked_is_final: an unchecked verification cannot change; check it again instead'
      using errcode = 'check_violation';
  end if;
  if new.id <> old.id
     or new.collection_id <> old.collection_id
     or new.verified_at <> old.verified_at
     or new.verified_by <> old.verified_by
     or new.verified_by_name <> old.verified_by_name then
    raise exception 'acct_sb_verif_append_only: a verification is never edited, only unchecked'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.accounting_scoreboard_verifications_guard_update() from public, anon, authenticated;

drop trigger if exists acct_sb_verif_guard_update on public.accounting_scoreboard_collection_verifications;
create trigger acct_sb_verif_guard_update
  before update on public.accounting_scoreboard_collection_verifications
  for each row execute function public.accounting_scoreboard_verifications_guard_update();

-- ===========================================================================
-- Payroll Problems: problem types (managers add to the list) and the problem log
-- ===========================================================================

create table if not exists public.accounting_scoreboard_problem_types (
  id           uuid primary key default gen_random_uuid(),
  label        text not null,
  constraint acct_sb_ptype_label_valid check (length(btrim(label)) between 1 and 60 and label = btrim(label)),
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  created_by   text not null,
  constraint acct_sb_ptype_created_by_present check (length(btrim(created_by)) > 0),
  -- Archived, never deleted: a logged problem keeps its type.
  archived_at  timestamptz,
  archived_by  text,
  constraint acct_sb_ptype_archive_pair check ((archived_at is null) = (archived_by is null))
);

create unique index if not exists acct_sb_ptype_one_live_label
  on public.accounting_scoreboard_problem_types (lower(label)) where archived_at is null;

comment on table public.accounting_scoreboard_problem_types is
  'Accounting Scoreboard payroll problem types. Managers add them; archived, never deleted. Service-role only.';

-- Carla's starting list.
insert into public.accounting_scoreboard_problem_types (label, sort_order, created_by)
select v.label, v.sort_order, 'migration 2026-10-06 (Carla''s starting list)'
from (values ('Account Error', 0), ('Scoreboard Error', 1), ('Other', 2)) as v (label, sort_order)
where not exists (
  select 1 from public.accounting_scoreboard_problem_types t where lower(t.label) = lower(v.label) and t.archived_at is null
);

-- One line per logged problem (or a batch of the same type: count). APPEND-ONLY like the
-- collections log: a mistake is deleted (soft, stamped) and logged again.
create table if not exists public.accounting_scoreboard_problems (
  id           uuid primary key default gen_random_uuid(),
  entry_date   date not null,

  row_id       uuid not null,
  section_key  text not null default 'payroll_problems',
  constraint acct_sb_prob_section_is_problems check (section_key = 'payroll_problems'),
  constraint acct_sb_prob_person_fk foreign key (row_id, section_key)
    references public.accounting_scoreboard_rows (id, section_key),

  type_id      uuid not null references public.accounting_scoreboard_problem_types (id),

  problem_count integer not null default 1,
  constraint acct_sb_prob_count_range check (problem_count between 1 and 1000),

  created_at   timestamptz not null default now(),
  created_by   text not null,
  constraint acct_sb_prob_created_by_present check (length(btrim(created_by)) > 0),

  deleted_at   timestamptz,
  deleted_by   text,
  constraint acct_sb_prob_delete_pair check ((deleted_at is null) = (deleted_by is null))
);

create index if not exists acct_sb_prob_live_by_date
  on public.accounting_scoreboard_problems (entry_date) where deleted_at is null;

comment on table public.accounting_scoreboard_problems is
  'Accounting Scoreboard payroll problem log. APPEND-ONLY: never edited, only soft-deleted once. Service-role only.';

create or replace function public.accounting_scoreboard_problems_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.deleted_at is not null then
    raise exception 'acct_sb_prob_deleted_is_final: a deleted problem cannot change'
      using errcode = 'check_violation';
  end if;
  if new.id <> old.id
     or new.entry_date <> old.entry_date
     or new.row_id <> old.row_id
     or new.section_key <> old.section_key
     or new.type_id <> old.type_id
     or new.problem_count <> old.problem_count
     or new.created_at <> old.created_at
     or new.created_by <> old.created_by then
    raise exception 'acct_sb_prob_append_only: a logged problem is never edited; delete it and log it again'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.accounting_scoreboard_problems_guard_update() from public, anon, authenticated;

drop trigger if exists acct_sb_prob_guard_update on public.accounting_scoreboard_problems;
create trigger acct_sb_prob_guard_update
  before update on public.accounting_scoreboard_problems
  for each row execute function public.accounting_scoreboard_problems_guard_update();

-- ===========================================================================
-- Data: Carla's layout on the rows the board already has (all guarded; a re-run changes nothing)
-- ===========================================================================
-- The apply script writes the rows these UPDATEs touch to docs/audits/backups/ BEFORE it runs.

-- The five weekday Collections buckets, by the labels they carried on 2026-10-06.
update public.accounting_scoreboard_rows r
set bucket_day = v.day
from (values
  ('Mon (Collections)', 'mon'), ('Tues (Collections)', 'tue'), ('Wed (Collections)', 'wed'),
  ('Thurs (Collections)', 'thu'), ('Fri (Collections)', 'fri')
) as v (label, day)
where r.section_key = 'buckets' and r.archived_at is null and r.label = v.label and r.bucket_day is null;

-- The Open Disputes row that counts the disputes due in the next 7 days.
update public.accounting_scoreboard_rows
set due_soon = true
where section_key = 'chargebacks' and archived_at is null and label = 'Disputes due in 7 days' and not due_soon;

-- Outcomes: Pre-arb, Wins and Losses move from the AM/PM grid to their own section ($ and # a day).
-- The AM/PM rows are ARCHIVED, never deleted: their numbers stay readable for the weeks they hold.
insert into public.accounting_scoreboard_rows (section_key, label, sort_order, created_by)
select 'chargeback_outcomes', v.label, v.sort_order, 'migration 2026-10-06 (Carla''s Outcomes section)'
from (values ('Pre-arb', 0), ('Wins', 1), ('Losses', 2)) as v (label, sort_order)
where not exists (
  select 1 from public.accounting_scoreboard_rows r
  where r.section_key = 'chargeback_outcomes' and r.archived_at is null and lower(r.label) = lower(v.label)
);

update public.accounting_scoreboard_rows
set archived_at = now(), archived_by = 'migration 2026-10-06 (moved to Chargeback Outcomes)'
where section_key = 'chargebacks' and archived_at is null and label in ('Pre-arb', 'Wins', 'Losses');

-- ===========================================================================
-- Lock-down: service role only
-- ===========================================================================

alter table public.accounting_scoreboard_custom_sections        enable row level security;
alter table public.accounting_scoreboard_collection_verifications enable row level security;
alter table public.accounting_scoreboard_problem_types           enable row level security;
alter table public.accounting_scoreboard_problems                enable row level security;

revoke all on table public.accounting_scoreboard_custom_sections        from anon, authenticated;
revoke all on table public.accounting_scoreboard_collection_verifications from anon, authenticated;
revoke all on table public.accounting_scoreboard_problem_types           from anon, authenticated;
revoke all on table public.accounting_scoreboard_problems                from anon, authenticated;
