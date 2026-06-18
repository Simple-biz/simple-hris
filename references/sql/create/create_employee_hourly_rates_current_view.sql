-- Latest-rate-per-email view over `employee_hourly_rates`.
--
-- The base table accumulates one row per (employee, upload) — ~9000 rows
-- for ~2660 distinct emails as of 2026-05-18. The Accounting prefetch
-- (src/lib/accounting/prefetch.ts) was pulling the full history just to
-- build a `Map<email, row>` that overwrites duplicates anyway, so ~70%
-- of the bytes shipped to the browser were wasted.
--
-- This view mirrors the OLD client-side dedup behavior exactly:
--   * The old path iterated all rows in PK order and called
--     `m.set(work_email, r)` + `m.set(personal_email, r)` for each, so
--     the row with the **highest id** per email always won.
--   * This view returns the highest-id row PER personal_email AND
--     PER work_email (unioned). Each lookup key still resolves to the
--     same row it did before — so payroll totals are byte-identical.
--
-- DO NOT switch to ordering by `upload_id` or `created_at` — earlier
-- versions of this view did, and silently changed rates for ~50
-- employees (some rows have NULL upload_id, or were inserted out of
-- upload-id order via manual fixes). `id` is the only stable ordering
-- the old code used.
--
-- `id` is UUID, so we use `DISTINCT ON ... ORDER BY id DESC` to pick
-- the lexicographically-greatest id per email (Postgres `MAX()` does
-- not support UUID directly).
--
-- Consumers that legitimately need rate HISTORY (mid-cycle prorating in
-- src/lib/payroll/current-pay.ts and member-monthly-pay.ts) read from
-- `employee_rate_history`, not this table, so they are unaffected.
--
-- To revert: see drop_employee_hourly_rates_current_view.sql.

-- Drop first because `CREATE OR REPLACE VIEW` can't change the column
-- list of an existing view. An earlier (broken) version of this view
-- had a hand-picked column subset; this version uses `SELECT *` from
-- the base table so all columns flow through.
drop view if exists public.employee_hourly_rates_current;

create view public.employee_hourly_rates_current as
with latest_by_personal as (
  select distinct on (lower(trim("Personal Email"))) *
  from public.employee_hourly_rates
  where nullif(trim("Personal Email"), '') is not null
  order by lower(trim("Personal Email")), id desc
),
latest_by_work as (
  select distinct on (lower(trim("Work Email"))) *
  from public.employee_hourly_rates
  where nullif(trim("Work Email"), '') is not null
  order by lower(trim("Work Email")), id desc
)
select * from latest_by_personal
union
select * from latest_by_work;

comment on view public.employee_hourly_rates_current is
  'Highest-id row per personal_email AND per work_email (unioned). Mirrors the old client-side dedup behavior in indexHourlyRatesByEmail so payroll totals are byte-identical. See references/create_employee_hourly_rates_current_view.sql.';
