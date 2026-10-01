-- Accounting Scoreboard — the in-HRIS rebuild of Carla's "Accounting Scoreboard" Google Sheet.
--
-- Kane, 2026-10-01: "we are not using appscript … just nextjs typescript … basically its in this
-- project … just on a different domain" · "accounting-bonus.vercel.app - lets point that here".
-- Governing doc: docs/features/accounting-scoreboard.md
-- Analysis:      docs/notes/2026-10-01-accounting-scoreboard-analysis.md
--
-- Five tables. The routes under /api/accounting-scoreboard/ are their only reader and writer, and
-- they stamp every *_by column from the SESSION email, never from the request body.
--
-- NOTHING HERE PAYS ANYONE. The one scoreboard number that reaches pay today (the collections day
-- totals behind the Payment Catalog's "Dancing Queen Bonus") is still typed into the KPI
-- calculator by hand. These tables never write bonus_catalog_applied. Whether that bonus should
-- count points or accounts is an open money ruling (audit Open item 315).
--
-- Service-role only. RLS is on with NO policies, table privileges are revoked from
-- anon/authenticated, the tables are NOT in supabase_realtime, and the trigger function is
-- revoked from PUBLIC/anon/authenticated. Not app_settings: that table is readable by every
-- signed-in user.
--
-- The section keys and entry slots below are pinned to src/lib/accounting-scoreboard/sections.ts
-- by sections.test.ts. Adding a section means editing both, and the test fails until you do.

-- ===========================================================================
-- Rows: what each section measures (a person, a queue, an inbox, a line)
-- ===========================================================================

create table if not exists public.accounting_scoreboard_rows (
  id           uuid primary key default gen_random_uuid(),

  section_key  text not null,
  constraint acct_sb_rows_section_valid check (section_key in (
    'buckets', 'chargebacks', 'pm_buckets', 'collections', 'onboarding',
    'compliance', 'inbox', 'cancellations', 'payroll_timing', 'payroll_problems'
  )),

  -- What the board prints: a person's short name, a bucket name, "Payroll Simple.biz", "Green".
  label        text not null,
  constraint acct_sb_rows_label_valid
    check (length(btrim(label)) between 1 and 80 and label = btrim(label)),

  -- Set when the row IS an HRIS person (picked from the roster). It also makes that person a
  -- member of the board. NULL for queues, inboxes, lines, and people not on the roster.
  work_email   text,
  constraint acct_sb_rows_email_valid check (
    work_email is null
    or (work_email = lower(btrim(work_email)) and work_email like '_%@_%' and length(work_email) <= 254)
  ),

  sort_order   integer not null default 0,

  created_at   timestamptz not null default now(),
  created_by   text not null,
  constraint acct_sb_rows_created_by_present check (length(btrim(created_by)) > 0),

  -- Rows are archived, never deleted: a collection logged against a rep keeps its rep.
  archived_at  timestamptz,
  archived_by  text,
  constraint acct_sb_rows_archive_pair check ((archived_at is null) = (archived_by is null)),

  -- The composite key the collections log points at, so a collection can only belong to a
  -- row of the collections section.
  constraint acct_sb_rows_id_section unique (id, section_key)
);

-- One live row per label, and one live row per person, in a section.
create unique index if not exists acct_sb_rows_one_live_label
  on public.accounting_scoreboard_rows (section_key, lower(label)) where archived_at is null;
create unique index if not exists acct_sb_rows_one_live_person
  on public.accounting_scoreboard_rows (section_key, work_email)
  where archived_at is null and work_email is not null;
create index if not exists acct_sb_rows_live_email
  on public.accounting_scoreboard_rows (work_email) where archived_at is null;

comment on table public.accounting_scoreboard_rows is
  'Accounting Scoreboard rows. One per measured person/queue/inbox/line per section. Archived, never deleted. Service-role only.';

-- ===========================================================================
-- Entries: one number per row, day and slot
-- ===========================================================================
--   am / pm     — morning and end-of-day counts (buckets, chargebacks, inbox)
--   day         — one count for the day (PM buckets, onboarding, compliance, cancellations, problems)
--   mtg         — PM buckets' "had a meeting" flag, 0 or 1
--   start / end — payroll processing start and end, as minutes after midnight (0–1440)
-- A cleared cell is a DELETED entry, never a stored 0: a 0 is a real count.

create table if not exists public.accounting_scoreboard_entries (
  row_id      uuid not null references public.accounting_scoreboard_rows (id) on delete cascade,
  entry_date  date not null,
  slot        text not null,
  constraint acct_sb_entries_slot_valid check (slot in ('am', 'pm', 'day', 'mtg', 'start', 'end')),

  value       numeric(12, 2) not null,
  constraint acct_sb_entries_value_range check (value >= 0 and value <= 100000),
  constraint acct_sb_entries_minutes_range check (slot not in ('start', 'end') or value <= 1440),
  constraint acct_sb_entries_flag_binary check (slot <> 'mtg' or value in (0, 1)),

  updated_at  timestamptz not null default now(),
  updated_by  text not null,
  constraint acct_sb_entries_updated_by_present check (length(btrim(updated_by)) > 0),

  constraint acct_sb_entries_pk primary key (row_id, entry_date, slot)
);

create index if not exists acct_sb_entries_by_date
  on public.accounting_scoreboard_entries (entry_date);

comment on table public.accounting_scoreboard_entries is
  'Accounting Scoreboard cell values: one per (row, date, slot). A cleared cell is deleted, never 0. Service-role only.';

-- ===========================================================================
-- Collections log: one row per collected account (the sheet's "Collection Count" tab)
-- ===========================================================================
-- APPEND-ONLY. The day totals of this log are the number the Dancing Queen Bonus is typed from,
-- so a logged collection is never edited: a mistake is deleted (soft, stamped) and re-logged.
-- The trigger below refuses every UPDATE except that one soft delete.

create table if not exists public.accounting_scoreboard_collections (
  id             uuid primary key default gen_random_uuid(),
  entry_date     date not null,

  row_id         uuid not null,
  section_key    text not null default 'collections',
  constraint acct_sb_coll_section_is_collections check (section_key = 'collections'),
  constraint acct_sb_coll_rep_fk foreign key (row_id, section_key)
    references public.accounting_scoreboard_rows (id, section_key),

  business_name  text not null,
  constraint acct_sb_coll_business_valid
    check (length(btrim(business_name)) between 1 and 200 and business_name = btrim(business_name)),

  -- Points as the sheet keeps them: usually 1, some accounts 2–14.
  points         numeric(6, 2) not null,
  constraint acct_sb_coll_points_range check (points >= 0 and points <= 100),

  amount_usd     numeric(12, 2),
  constraint acct_sb_coll_amount_range
    check (amount_usd is null or (amount_usd >= 0 and amount_usd <= 10000000)),

  created_at     timestamptz not null default now(),
  created_by     text not null,
  constraint acct_sb_coll_created_by_present check (length(btrim(created_by)) > 0),

  deleted_at     timestamptz,
  deleted_by     text,
  constraint acct_sb_coll_delete_pair check ((deleted_at is null) = (deleted_by is null))
);

create index if not exists acct_sb_coll_live_by_date
  on public.accounting_scoreboard_collections (entry_date) where deleted_at is null;

comment on table public.accounting_scoreboard_collections is
  'Accounting Scoreboard collections log. APPEND-ONLY: never edited, only soft-deleted once. Service-role only.';

create or replace function public.accounting_scoreboard_collections_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.deleted_at is not null then
    raise exception 'acct_sb_coll_deleted_is_final: a deleted collection cannot change'
      using errcode = 'check_violation';
  end if;
  if new.id <> old.id
     or new.entry_date <> old.entry_date
     or new.row_id <> old.row_id
     or new.section_key <> old.section_key
     or new.business_name <> old.business_name
     or new.points <> old.points
     or new.amount_usd is distinct from old.amount_usd
     or new.created_at <> old.created_at
     or new.created_by <> old.created_by then
    raise exception 'acct_sb_coll_append_only: a logged collection is never edited; delete it and log it again'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.accounting_scoreboard_collections_guard_update() from public, anon, authenticated;

drop trigger if exists acct_sb_coll_guard_update on public.accounting_scoreboard_collections;
create trigger acct_sb_coll_guard_update
  before update on public.accounting_scoreboard_collections
  for each row execute function public.accounting_scoreboard_collections_guard_update();

-- ===========================================================================
-- Members: people who may enter numbers without being a row
-- ===========================================================================
-- Membership is (live person rows' work emails) ∪ (this table, not removed). The `accounting` and
-- `admin` roles are the board's managers and need no row here.

create table if not exists public.accounting_scoreboard_members (
  work_email  text primary key,
  constraint acct_sb_members_email_valid
    check (work_email = lower(btrim(work_email)) and work_email like '_%@_%' and length(work_email) <= 254),

  added_at    timestamptz not null default now(),
  added_by    text not null,
  constraint acct_sb_members_added_by_present check (length(btrim(added_by)) > 0),

  removed_at  timestamptz,
  removed_by  text,
  constraint acct_sb_members_remove_pair check ((removed_at is null) = (removed_by is null))
);

comment on table public.accounting_scoreboard_members is
  'Accounting Scoreboard extra members (people who enter numbers but are not a row). Service-role only.';

-- ===========================================================================
-- Sections: a manager's on/off switch and goal override
-- ===========================================================================
-- A missing row means the code defaults (src/lib/accounting-scoreboard/sections.ts): on, default goal.

create table if not exists public.accounting_scoreboard_sections (
  section_key  text primary key,
  constraint acct_sb_sections_key_valid check (section_key in (
    'buckets', 'chargebacks', 'pm_buckets', 'collections', 'onboarding',
    'compliance', 'inbox', 'cancellations', 'payroll_timing', 'payroll_problems'
  )),
  enabled      boolean not null default true,
  goal         numeric(10, 2),
  constraint acct_sb_sections_goal_range check (goal is null or (goal >= 0 and goal <= 100000)),
  updated_at   timestamptz not null default now(),
  updated_by   text not null,
  constraint acct_sb_sections_updated_by_present check (length(btrim(updated_by)) > 0)
);

comment on table public.accounting_scoreboard_sections is
  'Accounting Scoreboard section switches and goal overrides. Missing row = code default. Service-role only.';

-- ===========================================================================
-- Lock-down: service role only
-- ===========================================================================

alter table public.accounting_scoreboard_rows        enable row level security;
alter table public.accounting_scoreboard_entries     enable row level security;
alter table public.accounting_scoreboard_collections enable row level security;
alter table public.accounting_scoreboard_members     enable row level security;
alter table public.accounting_scoreboard_sections    enable row level security;

revoke all on table public.accounting_scoreboard_rows        from anon, authenticated;
revoke all on table public.accounting_scoreboard_entries     from anon, authenticated;
revoke all on table public.accounting_scoreboard_collections from anon, authenticated;
revoke all on table public.accounting_scoreboard_members     from anon, authenticated;
revoke all on table public.accounting_scoreboard_sections    from anon, authenticated;
