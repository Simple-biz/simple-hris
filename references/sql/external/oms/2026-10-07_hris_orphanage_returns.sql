-- ============================================================================
-- Simple HRIS → OMS: orphanage pay return table
-- Run ONCE in the OMS Supabase project (SQL Editor, or as a migration).
-- NOT an HRIS migration — never run this against the HRIS database.
--
-- What it is for: after OMS approves a week's hours, the HRIS prices them and
-- sends back one row per person — emails, regular / OT hours, rates and the
-- amount paid — so OMS can report it to accounting.
--
-- How the HRIS uses it:
--   * INSERT and SELECT only. It never UPDATEs or DELETEs a row here, and it
--     never writes any other OMS table.
--   * One send = one push_id, written in a single insert (all rows or none).
--   * A re-send for the same week is a NEW push_id; older sends stay as history.
--   * To read a week: take the rows of the newest push_id for that week_start
--     (the index below serves exactly that query).
--
-- The column list is a contract: the HRIS writes exactly these 17 columns.
-- Please don't rename or drop any without telling us first.
-- ============================================================================

begin;

create table if not exists public.hris_orphanage_returns (
  push_id           uuid           not null,  -- one per send
  pushed_at         timestamptz    not null,
  pushed_by         text           not null,  -- the HRIS user who pressed Send
  source_file       text           not null,  -- the hours file the week came from
  week_start        date           not null,  -- the pay week's Sunday
  pay_week          text,                     -- display label, e.g. '9/13- 9/19'
  work_email        text           not null,  -- the address OMS knows the person by
  hris_email        text           not null,  -- the address the HRIS pays under
  employee_name     text,
  hours             numeric(12,4),            -- the hours fields are null when the amount was entered by hand
  regular_hours     numeric(12,4),
  ot_hours          numeric(12,4),
  regular_rate_php  numeric(14,4),
  ot_rate_php       numeric(14,4),
  amount_php        numeric(14,2)  not null,  -- what is paid, in PHP
  verdict           text           not null check (verdict in ('ok', 'amount_mismatch', 'ot_underpriced', 'unverifiable')),
  cycle_locked      boolean        not null,  -- true = payroll was locked at send time, the figure is final
  primary key (push_id, hris_email)
);

create index if not exists hris_orphanage_returns_week_idx
  on public.hris_orphanage_returns (week_start, pushed_at desc);

-- ---------------------------------------------------------------------------
-- Access. The rows carry employee emails and pay, so nothing is public.
-- The HRIS connects with this project's SECRET (service_role) key, which
-- bypasses RLS. It gets SELECT + INSERT here and no UPDATE / DELETE, so the
-- history cannot be rewritten from the HRIS side. The table owner (postgres)
-- keeps full rights.
-- ---------------------------------------------------------------------------
alter table public.hris_orphanage_returns enable row level security;

revoke all on public.hris_orphanage_returns from anon, authenticated;
revoke update, delete, truncate on public.hris_orphanage_returns from service_role;
grant select, insert on public.hris_orphanage_returns to service_role;

-- OPTIONAL — only if the OMS app reads this table as a signed-in user (not with
-- the secret key). Narrow the policy to whoever reports to accounting.
-- grant select on public.hris_orphanage_returns to authenticated;
-- create policy hris_orphanage_returns_read on public.hris_orphanage_returns
--   for select to authenticated using (true);

commit;

-- Make the table visible to the API immediately.
notify pgrst, 'reload schema';

-- Check (should return 0):
-- select count(*) from public.hris_orphanage_returns;
