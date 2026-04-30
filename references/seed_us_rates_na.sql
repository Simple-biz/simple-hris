-- ============================================================
-- Set US employees' Regular Rate and OT Rate to 0 in
-- employee_hourly_rates.
--
-- Brandon Biggs may not have a row yet — the final INSERT
-- adds him only if missing.
-- ============================================================

UPDATE public.employee_hourly_rates
SET "Regular Rate" = 0,
    "OT Rate"      = 0
WHERE LOWER("Work Email") IN (
  'thomas@simple.biz', 'jeff@simple.biz', 'teal@simple.biz', 'carla@simple.biz',
  'emma@simple.biz', 'jackie@simple.biz', 'courtney@simple.biz',
  'seungyong@simple.biz', 'nicholas@simple.biz', 'sterling@simple.biz',
  'adrian@simple.biz', 'brandonb@simple.biz'
);

-- Brandon Biggs is a new hire — INSERT only if no row yet.
INSERT INTO public.employee_hourly_rates ("Work Email", "Regular Rate", "OT Rate")
SELECT 'brandonb@simple.biz', 0, 0
WHERE NOT EXISTS (
  SELECT 1 FROM public.employee_hourly_rates
  WHERE LOWER("Work Email") = 'brandonb@simple.biz'
);

-- Verify
SELECT "Work Email", "Regular Rate", "OT Rate", "Department"
FROM public.employee_hourly_rates
WHERE LOWER("Work Email") IN (
  'thomas@simple.biz', 'jeff@simple.biz', 'teal@simple.biz', 'carla@simple.biz',
  'emma@simple.biz', 'jackie@simple.biz', 'courtney@simple.biz',
  'seungyong@simple.biz', 'nicholas@simple.biz', 'sterling@simple.biz',
  'adrian@simple.biz', 'brandonb@simple.biz'
)
ORDER BY "Work Email";
