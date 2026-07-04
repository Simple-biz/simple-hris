-- MESA enrollment effective date
-- ---------------------------------------------------------------------------
-- Adds `mesa_member_since` (a DATE) to employee_hourly_rates. This is the week
-- from which a member starts contributing ₱100. Before this column existed the
-- app treated `mesa_member = true` as "has contributed every week since hire",
-- which (a) made the Payroll Wizard deduct ₱100 for pre-enrollment / replayed
-- weeks and (b) made the employee MESA History tab count contributions from the
-- hire date. With an enrollment date, both surfaces only count weeks on/after it.
--
-- Semantics: a NULL `mesa_member_since` = legacy member (enrolled before we
-- tracked the date) → treated as "always contributing", preserving old behavior
-- until HR restamps. New enrollments (HR opt-in approval) stamp the approval date.
--
-- Run once in the Supabase SQL editor. Safe to re-run.

ALTER TABLE employee_hourly_rates
  ADD COLUMN IF NOT EXISTS mesa_member_since date;

COMMENT ON COLUMN employee_hourly_rates.mesa_member_since IS
  'MESA enrollment effective date. The ₱100 weekly contribution applies only to pay weeks ending on/after this date. NULL = legacy member (always contributing).';

-- ---------------------------------------------------------------------------
-- The `employee_hourly_rates_current` view is defined with `SELECT ehr.*`, but
-- Postgres snapshots the column list at CREATE time — a newly-added base column
-- does NOT appear in the view until it is recreated. Rebuild it (identical to
-- references/sql/fix/fix_employee_hourly_rates_current_view_by_upload.sql) so the
-- Payroll Wizard / Overview read path (which prefers this view) can see the new
-- column. If the view doesn't exist on your project, this block is a harmless
-- recreate.
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
  'Current rate per personal_email AND per work_email (unioned), picked by is_current upload then uploaded_at then id desc. Replaces the old random-UUID (id desc only) ordering that froze employees on stale rates. See references/fix_employee_hourly_rates_current_view_by_upload.sql.';

-- ---------------------------------------------------------------------------
-- ONE-OFF BACKFILL — kaner@simple.biz
-- Passed FPU 2026-06-15, approved into MESA (manually, outside the HRIS) for the
-- 2026-06-21 → 2026-06-27 pay cycle only. Stamp his enrollment to the start of
-- that cycle so he shows exactly ONE completed contribution, not every week
-- since hire. Updates every row for the email so the `current` view picks it up.
update employee_hourly_rates
set mesa_member = true,
    mesa_member_since = date '2026-06-21'
where lower(trim("Work Email")) = 'kaner@simple.biz';
