-- MESA FPU completion + opt-in confirmation dates
-- ---------------------------------------------------------------------------
-- Adds two DATE columns to employee_hourly_rates, sourced from the MESA active
-- export (mesa_ledger):
--
--   mesa_fpu_completed_on        -- fpu_completion_date  (when the member finished
--                                   Financial Peace University). Powers the
--                                   employee Opt-in form's "Date you completed FPU"
--                                   pre-fill for already-enrolled members.
--   mesa_optin_confirmation_sent -- optin_confirmation_sent (when Accounting sent
--                                   their MESA opt-in confirmation). Stored for
--                                   records / audit; not currently surfaced.
--
-- Before this, the app had no real FPU date for the ~295 bulk-enrolled members
-- and fell back to mesa_member_since (first deposit) as a proxy. These columns
-- give the true dates.
--
-- Run once in the Supabase SQL editor. Safe to re-run. Backfill values with
-- scripts/backfill-mesa-fpu-dates.mjs --apply (reads mesa_ledger).

ALTER TABLE employee_hourly_rates
  ADD COLUMN IF NOT EXISTS mesa_fpu_completed_on        date,
  ADD COLUMN IF NOT EXISTS mesa_optin_confirmation_sent date;

COMMENT ON COLUMN employee_hourly_rates.mesa_fpu_completed_on IS
  'Date the member completed FPU (from mesa_ledger.fpu_completion_date). Pre-fills the employee Opt-in form for enrolled members.';
COMMENT ON COLUMN employee_hourly_rates.mesa_optin_confirmation_sent IS
  'Date the MESA opt-in confirmation was sent (from mesa_ledger.optin_confirmation_sent). Records/audit.';

-- ---------------------------------------------------------------------------
-- The `employee_hourly_rates_current` view is `SELECT ehr.*`, but Postgres
-- snapshots the column list at CREATE time — newly-added base columns do NOT
-- appear until the view is recreated. Rebuild it (identical to
-- add_mesa_member_since.sql) so the single-row read path sees the new columns.
drop view if exists public.employee_hourly_rates_current;

create view public.employee_hourly_rates_current as
with ranked as (
  select
    ehr.*,
    ru.is_current  as _ru_is_current,
    ru.uploaded_at as _ru_uploaded_at
  from public.employee_hourly_rates ehr
  left join public.rates_uploads ru on ru.id = ehr.upload_id
),
latest_by_personal as (
  select distinct on (lower(trim("Personal Email"))) *
  from ranked
  where nullif(trim("Personal Email"), '') is not null
  order by
    lower(trim("Personal Email")),
    _ru_is_current  desc nulls last,
    _ru_uploaded_at desc nulls last,
    id desc
),
latest_by_work as (
  select distinct on (lower(trim("Work Email"))) *
  from ranked
  where nullif(trim("Work Email"), '') is not null
  order by
    lower(trim("Work Email")),
    _ru_is_current  desc nulls last,
    _ru_uploaded_at desc nulls last,
    id desc
)
select * from latest_by_personal
union
select * from latest_by_work;

comment on view public.employee_hourly_rates_current is
  'Current rate per personal_email AND per work_email (unioned), picked by is_current upload then uploaded_at then id desc.';
