-- ============================================================================
-- RETIRE the "US Manager Bonus" / "US Team" department (2026-07-07).
--
-- WHY
--   The US-based staff are already on the Global Master List and are treated as
--   RECORD-ONLY in HRIS (paid via a separate US track; contractors among them go
--   through the contractor-invoice flow, not the PHP dept-bonus payroll). The
--   dedicated "US Manager Bonus" department is therefore redundant and has been
--   removed from the bonus system in code (department list, KPI calculator,
--   currency-forcing, PAB/Tech exclusion allowlist, System Settings, colours,
--   skill-set titles). This migration re-labels the 12 rows so the roster no
--   longer shows the retired department name.
--
-- WHAT THIS DOES
--   Re-tags the 12 previously-merged US rows from 'US Manager Bonus' to the new
--   label below, in BOTH global_master_list and employee_hourly_rates.
--
-- SAFETY
--   * The new label maps to NO payroll department key (normalizeDeptToKey), so
--     these people never enter any KPI calculator or dept-bonus payroll.
--   * They are excluded from PHP dispatch entirely (record-only), so losing the
--     old PAB/Tech exclusion + USD-forcing has no payout effect.
--   * Idempotent: only rows still carrying an old label are touched; re-running
--     is a no-op. Matches by Work Email (the 12 seeded US emails).
-- ============================================================================

-- ── The one place to change the new department label ────────────────────────
--    (Set to whatever you want the 12 US rows to read as on the roster.)
WITH cfg AS (
  SELECT 'US Employees'::text AS new_label
),
us_emails(work_email) AS (VALUES
  ('thomas@simple.biz'),
  ('jeff@simple.biz'),
  ('teal@simple.biz'),
  ('carla@simple.biz'),
  ('emma@simple.biz'),
  ('jackie@simple.biz'),
  ('courtney@simple.biz'),
  ('seungyong@simple.biz'),
  ('nicholas@simple.biz'),
  ('sterling@simple.biz'),
  ('adrian@simple.biz'),
  ('brandonb@simple.biz')
),
-- Old labels that resolved to the retired department (case-insensitive).
old_labels(lbl) AS (VALUES
  ('us manager bonus'),
  ('us - manager bonus'),
  ('manager bonus'),
  ('us team'),
  ('us - team')
)
UPDATE public.global_master_list g
SET    "Department" = (SELECT new_label FROM cfg)
WHERE  LOWER(TRIM(g."Work Email")) IN (SELECT work_email FROM us_emails)
  AND  LOWER(TRIM(g."Department"))  IN (SELECT lbl FROM old_labels)
  AND  g."Department" IS DISTINCT FROM (SELECT new_label FROM cfg);

-- Mirror the change in employee_hourly_rates so the Rates page / Payroll Wizard
-- scoping see the same label.
WITH cfg AS (
  SELECT 'US Employees'::text AS new_label
),
us_emails(work_email) AS (VALUES
  ('thomas@simple.biz'),
  ('jeff@simple.biz'),
  ('teal@simple.biz'),
  ('carla@simple.biz'),
  ('emma@simple.biz'),
  ('jackie@simple.biz'),
  ('courtney@simple.biz'),
  ('seungyong@simple.biz'),
  ('nicholas@simple.biz'),
  ('sterling@simple.biz'),
  ('adrian@simple.biz'),
  ('brandonb@simple.biz')
),
old_labels(lbl) AS (VALUES
  ('us manager bonus'),
  ('us - manager bonus'),
  ('manager bonus'),
  ('us team'),
  ('us - team')
)
UPDATE public.employee_hourly_rates r
SET    "Department" = (SELECT new_label FROM cfg)
WHERE  LOWER(TRIM(r."Work Email")) IN (SELECT work_email FROM us_emails)
  AND  LOWER(TRIM(r."Department"))  IN (SELECT lbl FROM old_labels)
  AND  r."Department" IS DISTINCT FROM (SELECT new_label FROM cfg);

-- ── Verify: the 12 rows should now all read the new label, none of the old ──
SELECT g."Department", COUNT(*) AS n
FROM   public.global_master_list g
WHERE  LOWER(TRIM(g."Work Email")) IN (
         'thomas@simple.biz','jeff@simple.biz','teal@simple.biz','carla@simple.biz',
         'emma@simple.biz','jackie@simple.biz','courtney@simple.biz','seungyong@simple.biz',
         'nicholas@simple.biz','sterling@simple.biz','adrian@simple.biz','brandonb@simple.biz'
       )
GROUP  BY g."Department"
ORDER  BY n DESC;

-- Sanity: no row anywhere should still carry a retired "US Manager Bonus" label.
SELECT 'global_master_list' AS tbl, COUNT(*) AS leftover_us_manager_bonus
FROM   public.global_master_list
WHERE  LOWER(TRIM("Department")) IN ('us manager bonus','us - manager bonus','manager bonus','us team','us - team')
UNION ALL
SELECT 'employee_hourly_rates', COUNT(*)
FROM   public.employee_hourly_rates
WHERE  LOWER(TRIM("Department")) IN ('us manager bonus','us - manager bonus','manager bonus','us team','us - team');
