-- Revert: drop the latest-rate-per-email view.
-- Pair of references/create_employee_hourly_rates_current_view.sql.
--
-- After running this, the TS fallback in getEmployeeHourlyRatesRows()
-- will detect the missing view and transparently read the base table
-- via the original paginated path — no app deploy needed to revert.

drop view if exists public.employee_hourly_rates_current;
