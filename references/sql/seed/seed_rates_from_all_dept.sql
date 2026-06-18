-- ============================================================
-- Seed / gap-fill employee_hourly_rates from NEW Payroll Dashboard All Dept
--
-- Purpose
-- - Use the latest Week row per Work Email from the All Dept export
-- - Insert employees missing from employee_hourly_rates
-- - Fill missing Regular Rate / OT Rate on existing rows
-- - Preserve existing non-null rates by default
--
-- How to use
-- 1. Replace the VALUES rows in all_dept_raw with your All Dept CSV data
--    using only these columns:
--      Work Email, Personal Email, Week, Regular Rate, OT Rate
-- 2. Run in Supabase SQL Editor
-- 3. Review the final SELECT summary + missing-rate check
--
-- Notes
-- - Week must look like: Week 4/15/25 - 4/21/25
-- - Latest week wins per Work Email
-- - Work Email is normalized to lower-case for matching
-- - Regular Rate is required; OT Rate may be null
-- ============================================================

WITH all_dept_raw(work_email, personal_email, week_label, regular_rate_raw, ot_rate_raw) AS (
  VALUES
    -- Paste rows here from the All Dept export, for example:
    -- ('someone@simple.biz', 'someone@gmail.com', 'Week 4/15/25 - 4/21/25', '225', '337.50')
    ('__replace_me__@simple.biz', NULL, 'Week 1/1/25 - 1/7/25', '0', NULL)
),

normalized AS (
  SELECT
    lower(nullif(trim(work_email), ''))                                        AS work_email,
    lower(nullif(trim(personal_email), ''))                                    AS personal_email,
    nullif(trim(week_label), '')                                               AS week_label,
    nullif(regexp_replace(coalesce(regular_rate_raw, ''), '[^0-9.\-]', '', 'g'), '')::numeric
                                                                              AS regular_rate,
    nullif(regexp_replace(coalesce(ot_rate_raw, ''),      '[^0-9.\-]', '', 'g'), '')::numeric
                                                                              AS ot_rate
  FROM all_dept_raw
),

filtered AS (
  SELECT
    n.*,
    CASE
      WHEN n.week_label ~* 'Week\s+\d{1,2}/\d{1,2}/\d{2,4}\s*[-–]'
      THEN to_date(
        regexp_replace(n.week_label, '^.*?Week\s+(\d{1,2}/\d{1,2}/\d{2,4}).*$', '\1', 'i'),
        CASE
          WHEN regexp_replace(n.week_label, '^.*?Week\s+(\d{1,2}/\d{1,2}/\d{2,4}).*$', '\1', 'i') ~ '\d{4}$'
            THEN 'MM/DD/YYYY'
          ELSE 'MM/DD/YY'
        END
      )
      ELSE NULL
    END AS week_start
  FROM normalized n
  WHERE n.work_email IS NOT NULL
    AND n.regular_rate IS NOT NULL
),

latest_per_email AS (
  SELECT DISTINCT ON (work_email)
    work_email,
    personal_email,
    week_label,
    week_start,
    regular_rate,
    ot_rate
  FROM filtered
  ORDER BY work_email, week_start DESC NULLS LAST, week_label DESC NULLS LAST
),

inserted_rates AS (
  INSERT INTO employee_hourly_rates ("Work Email", "Personal Email", "Regular Rate", "OT Rate")
  SELECT
    s.work_email,
    s.personal_email,
    s.regular_rate,
    s.ot_rate
  FROM latest_per_email s
  WHERE NOT EXISTS (
    SELECT 1
    FROM employee_hourly_rates r
    WHERE lower(trim(r."Work Email")) = s.work_email
  )
  RETURNING "Work Email"
),

updated_blank_rates AS (
  UPDATE employee_hourly_rates r
  SET
    "Personal Email" = COALESCE(r."Personal Email", s.personal_email),
    "Regular Rate"   = COALESCE(r."Regular Rate", s.regular_rate),
    "OT Rate"        = COALESCE(r."OT Rate", s.ot_rate)
  FROM latest_per_email s
  WHERE lower(trim(r."Work Email")) = s.work_email
    AND (
      r."Personal Email" IS NULL
      OR r."Regular Rate" IS NULL
      OR r."OT Rate" IS NULL
    )
  RETURNING r."Work Email"
)

SELECT
  (SELECT count(*) FROM latest_per_email)    AS latest_rows_used,
  (SELECT count(*) FROM inserted_rates)      AS rows_inserted,
  (SELECT count(*) FROM updated_blank_rates) AS rows_blank_filled;

-- Employees still missing at least one rate after the seed.
SELECT
  lower(trim("Work Email")) AS work_email,
  "Personal Email"          AS personal_email,
  "Regular Rate"            AS regular_rate,
  "OT Rate"                 AS ot_rate
FROM employee_hourly_rates
WHERE coalesce(trim("Work Email"), '') <> ''
  AND ("Regular Rate" IS NULL OR "OT Rate" IS NULL)
ORDER BY lower(trim("Work Email"));
