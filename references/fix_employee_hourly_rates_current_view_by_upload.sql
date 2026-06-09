-- Rebuild `employee_hourly_rates_current` to pick each employee's CURRENT rate
-- by upload recency, not by random UUID.
--
-- BUG THIS FIXES
-- --------------
-- The prior view (create_employee_hourly_rates_current_view.sql) selected
-- `distinct on (email) ... order by id desc`. `id` is a random UUID, so
-- "highest id" had ZERO correlation with which upload was newest. An employee
-- whose oldest row happened to draw the lexicographically-greatest UUID was
-- frozen on that stale rate forever — every newer sync inserts/updates rows with
-- (mostly) lower UUIDs that the view never surfaces.
--   Real case: chag@simple.biz showed 175 in the Payroll Wizard / Overview even
--   though every recent Google-Sheet sync wrote 260 — her highest-UUID row was
--   an old 175 batch.
--
-- NEW ORDERING (per email, first wins)
--   1. row belongs to the `is_current` rates_upload   (rates_uploads.is_current)
--   2. then most recent upload                         (rates_uploads.uploaded_at)
--   3. then highest id                                 (stable tiebreaker; also
--                                                       the ONLY key available for
--                                                       rows with NULL upload_id —
--                                                       legacy manual inserts)
--
-- WHY THIS IS SAFE vs. the old warning about ordering by upload_id/created_at:
--   * Both the sync and a manual rate edit keep the is_current-upload row fresh:
--       - sync: UPDATEs the matched row's rate AND rewrites its upload_id to the
--         new (is_current) upload, so the is_current row always holds the freshest
--         synced value.
--       - manual edit (/api/update-employee-rates → updateEmployeeRates): UPDATEs
--         EVERY row for that email by Work/Personal Email, so the is_current row
--         gets the new value too.
--   * Rows with NULL upload_id fall through to `id desc` — identical to the old
--     behavior for exactly the rows the old comment worried about.
--
-- Consumers that need rate HISTORY (mid-cycle prorating in current-pay.ts /
-- member-monthly-pay.ts) read `employee_rate_history`, not this view.
--
-- To revert: re-run create_employee_hourly_rates_current_view.sql.

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
