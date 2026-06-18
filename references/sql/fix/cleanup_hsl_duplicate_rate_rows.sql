-- One-time cleanup of duplicate HSL rows in `employee_hourly_rates`.
--
-- Background: the first version of the Hogan-sheet bridge in
-- `mirrorHslRatesToEmployeeHourlyRates` (src/lib/supabase/hsl-upload-db.ts)
-- used `.range(0, 9999)` to read existing rows so it could decide whether to
-- UPDATE or INSERT. PostgREST silently caps single-request reads at 1000
-- rows, so any HSL employee whose existing row was past position 1000 was
-- never found in the lookup — every Hogan-sheet sync INSERTed a brand-new
-- row for them instead of updating in place. After a couple of syncs the
-- table had ~167 duplicate rows across ~147 HSL emails.
--
-- The bug is now fixed (the lookup paginates). This script just deletes the
-- leftover duplicates so the table is clean. Keeps the highest-id row per
-- Work Email and drops the rest.
--
-- Safe to re-run — if there are no duplicates, the DELETE is a no-op.

delete from public.employee_hourly_rates
where "Department" = 'Hogan Smith Law'
  and id not in (
    select distinct on (lower(trim("Work Email"))) id
    from public.employee_hourly_rates
    where "Department" = 'Hogan Smith Law'
      and nullif(trim("Work Email"), '') is not null
    order by lower(trim("Work Email")), id desc
  );

-- Verification: should return one row per HSL email, no duplicates.
-- select lower(trim("Work Email")) as email, count(*)
-- from public.employee_hourly_rates
-- where "Department" = 'Hogan Smith Law'
-- group by 1
-- having count(*) > 1;
