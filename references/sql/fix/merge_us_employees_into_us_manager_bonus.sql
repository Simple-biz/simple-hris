-- ============================================================
-- Re-tag every US-based employee (12 rows seeded in
-- references/seed_us_global_master_list.sql) into the single
-- "US Manager Bonus" department so the HR Active roster filter
-- shows them as one group.
--
-- Previously these 12 rows were split across three departments:
--   US Manager Bonus  — seungyong, jeff, carla, jackie
--   Hogan Smith Law   — thomas, courtney, emma, nicholas, sterling, adrian, brandonb
--   HR                — teal
--
-- After this migration: all 12 land in "US Manager Bonus".
-- Idempotent: re-running is a no-op once everyone is tagged.
-- ============================================================

UPDATE public.global_master_list
SET "Department" = 'US Manager Bonus'
WHERE LOWER("Work Email") IN (
  'thomas@simple.biz',
  'jeff@simple.biz',
  'teal@simple.biz',
  'carla@simple.biz',
  'emma@simple.biz',
  'jackie@simple.biz',
  'courtney@simple.biz',
  'seungyong@simple.biz',
  'nicholas@simple.biz',
  'sterling@simple.biz',
  'adrian@simple.biz',
  'brandonb@simple.biz'
)
AND ("Department" IS DISTINCT FROM 'US Manager Bonus');

-- Mirror the change in employee_hourly_rates so per-rate views (Rates page,
-- Payroll Wizard scoping) also see these as US Manager Bonus.
UPDATE public.employee_hourly_rates
SET "Department" = 'US Manager Bonus'
WHERE LOWER("Work Email") IN (
  'thomas@simple.biz',
  'jeff@simple.biz',
  'teal@simple.biz',
  'carla@simple.biz',
  'emma@simple.biz',
  'jackie@simple.biz',
  'courtney@simple.biz',
  'seungyong@simple.biz',
  'nicholas@simple.biz',
  'sterling@simple.biz',
  'adrian@simple.biz',
  'brandonb@simple.biz'
)
AND ("Department" IS DISTINCT FROM 'US Manager Bonus');

-- ── Verify ──
SELECT "Department", COUNT(*) AS n
FROM public.global_master_list
WHERE LOWER("Work Email") IN (
  'thomas@simple.biz','jeff@simple.biz','teal@simple.biz','carla@simple.biz',
  'emma@simple.biz','jackie@simple.biz','courtney@simple.biz','seungyong@simple.biz',
  'nicholas@simple.biz','sterling@simple.biz','adrian@simple.biz','brandonb@simple.biz'
)
GROUP BY "Department";
