-- ============================================================
-- 2026-07-21_hsl_bonus_entries_work_email.sql
-- Re-key HSL KPI Calculator entries from PERSONAL → WORK email.
--
-- WHY
--   External members added to an HSL dept's KPI Calculator before the
--   "work email only" fix were keyed by their PERSONAL email (candidateEmail
--   used personal-first). Those rows show a gmail/personal address in the
--   calculator (the "EXT" rows) and store a personal-email identity. All of HSL
--   keys people by WORK email (the hsl_team_members roster + the hardcoded
--   Managers cohort are all @simple.biz), and Hubstaff matches on work email,
--   so these personal-keyed rows are the odd ones out.
--
--   This rewrites each such row's employee_email to the person's WORK email,
--   resolved from global_master_list by their Personal Email. employee_name is
--   left untouched.
--
-- SAFE + IDEMPOTENT
--   • Only rows whose employee_email matches a known Personal Email that has a
--     DISTINCT Work Email are touched.
--   • A row that would collide with an already-existing work-keyed row for the
--     same (department, period_start) is LEFT ALONE (see POST-CHECK 2) — the
--     UPDATE's NOT EXISTS guard skips it, so no scored payroll row is destroyed
--     and the (department, period_start, employee_email) unique index never trips.
--   • Re-running is a no-op: once a row is work-keyed it no longer matches the map.
--
-- Run in the Supabase SQL editor. Review PREVIEW first if you want to eyeball it.
-- ============================================================

-- ── PREVIEW (optional; read-only) — rows that WILL be re-keyed ────────────────
-- WITH email_map AS (
--   SELECT personal_email, work_email FROM (
--     SELECT lower(trim("Personal Email")) AS personal_email,
--            lower(trim("Work Email"))     AS work_email,
--            row_number() OVER (PARTITION BY lower(trim("Personal Email"))
--                               ORDER BY lower(trim("Work Email"))) AS rn
--     FROM public.global_master_list
--     WHERE coalesce(trim("Personal Email"), '') <> ''
--       AND coalesce(trim("Work Email"),     '') <> ''
--   ) d WHERE rn = 1
-- )
-- SELECT e.department, e.period_start, e.employee_name,
--        e.employee_email AS old_email, m.work_email AS new_email
-- FROM public.hsl_bonus_entries e
-- JOIN email_map m ON lower(trim(e.employee_email)) = m.personal_email
-- WHERE m.work_email <> lower(trim(e.employee_email))
--   AND NOT EXISTS (
--     SELECT 1 FROM public.hsl_bonus_entries x
--     WHERE x.department = e.department AND x.period_start = e.period_start
--       AND lower(trim(x.employee_email)) = m.work_email)
-- ORDER BY e.employee_name;

BEGIN;

WITH email_map AS (
  -- One work email per personal email (global_master_list can hold dupe-person
  -- rows — pick deterministically so the JOIN never fans a row out).
  SELECT personal_email, work_email FROM (
    SELECT lower(trim("Personal Email")) AS personal_email,
           lower(trim("Work Email"))     AS work_email,
           row_number() OVER (PARTITION BY lower(trim("Personal Email"))
                              ORDER BY lower(trim("Work Email"))) AS rn
    FROM public.global_master_list
    WHERE coalesce(trim("Personal Email"), '') <> ''
      AND coalesce(trim("Work Email"),     '') <> ''
  ) d WHERE rn = 1
)
UPDATE public.hsl_bonus_entries e
SET employee_email = m.work_email,
    updated_at     = now()
FROM email_map m
WHERE lower(trim(e.employee_email)) = m.personal_email
  AND m.work_email <> lower(trim(e.employee_email))
  -- Skip (don't destroy) a personal-keyed row when a work-keyed row already
  -- exists for the same dept+period — avoids a unique-index collision.
  AND NOT EXISTS (
    SELECT 1 FROM public.hsl_bonus_entries x
    WHERE x.department   = e.department
      AND x.period_start = e.period_start
      AND lower(trim(x.employee_email)) = m.work_email
  );

COMMIT;

-- ── POST-CHECK 1 — entries STILL keyed by a personal email ────────────────────
-- Expect only people with NO work email on file (nothing to re-key to). If a
-- name here should have a work email, fix it in global_master_list and re-run.
-- WITH email_map AS (
--   SELECT lower(trim("Personal Email")) AS personal_email
--   FROM public.global_master_list
--   WHERE coalesce(trim("Personal Email"), '') <> ''
-- )
-- SELECT e.department, e.period_start, e.employee_name, e.employee_email
-- FROM public.hsl_bonus_entries e
-- JOIN email_map m ON lower(trim(e.employee_email)) = m.personal_email
-- ORDER BY e.employee_name;

-- ── POST-CHECK 2 — collisions that were intentionally SKIPPED ─────────────────
-- A personal-keyed row that already has a work-keyed twin in the same dept+period.
-- Review these by hand (usually a double-add): keep one, delete the other.
-- WITH email_map AS (
--   SELECT personal_email, work_email FROM (
--     SELECT lower(trim("Personal Email")) AS personal_email,
--            lower(trim("Work Email"))     AS work_email,
--            row_number() OVER (PARTITION BY lower(trim("Personal Email"))
--                               ORDER BY lower(trim("Work Email"))) AS rn
--     FROM public.global_master_list
--     WHERE coalesce(trim("Personal Email"), '') <> ''
--       AND coalesce(trim("Work Email"),     '') <> ''
--   ) d WHERE rn = 1
-- )
-- SELECT e.department, e.period_start, e.employee_name,
--        e.employee_email AS personal_keyed, m.work_email AS work_twin
-- FROM public.hsl_bonus_entries e
-- JOIN email_map m ON lower(trim(e.employee_email)) = m.personal_email
-- WHERE m.work_email <> lower(trim(e.employee_email))
--   AND EXISTS (
--     SELECT 1 FROM public.hsl_bonus_entries x
--     WHERE x.department = e.department AND x.period_start = e.period_start
--       AND lower(trim(x.employee_email)) = m.work_email)
-- ORDER BY e.employee_name;
