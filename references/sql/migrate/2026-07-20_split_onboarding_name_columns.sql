-- ============================================================================
-- Split the combined name into structured parts — `first_name` / `last_name` /
-- `name_extension` on `hr_onboarding_submissions` + `hr_pending_employees`
-- Generated: 2026-07-20
--
-- Why
--   The onboarding paperwork already captures First / Last / Extension in three
--   separate boxes, but they were being MERGED into one `full_name` string at
--   submit and then RE-PARSED all over the app (work-email + gmail-surname
--   derivation, CallTools username minting, the HR detail modal, the re-edit
--   prefill) with heuristics that guess where a compound surname starts, which
--   of several first names is the go-by, and whether a trailing token is a
--   generational suffix. Every guess can be wrong ("Dela Cruz", "Mary Grace",
--   "Jr.").
--
--   This adds the three parts as the SOURCE OF TRUTH so nothing re-parses.
--   `full_name` / `name` are KEPT and stay authoritative for the Google Sheet
--   master-list "Name" column, payroll name-token matching, and the
--   surname-first `display_name` trigger — the app now COMPOSES them from the
--   parts on every write (same string as before), so those consumers are
--   untouched. We just also persist the split and read it directly.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + the backfill only touches rows whose
-- first_name is still NULL, so re-running is safe.
--
-- Backfill logic MIRRORS splitName() in app/onboarding/[token]/page.tsx and
-- splitFullName() in src/lib/hr/work-email.ts:
--   • first  = first whitespace token
--   • last   = the WHOLE remainder joined by spaces ("Jane Dela Cruz" -> "Dela Cruz")
--   • ext    = a trailing generational suffix (jr/jr./sr/sr./ii/iii/iv), peeled
--              ONLY when >= 3 tokens remain so a 2-token name keeps its surname.
-- ============================================================================

-- 1) Columns ────────────────────────────────────────────────────────────────
ALTER TABLE public.hr_onboarding_submissions
  ADD COLUMN IF NOT EXISTS first_name     TEXT,
  ADD COLUMN IF NOT EXISTS last_name      TEXT,
  ADD COLUMN IF NOT EXISTS name_extension TEXT;

ALTER TABLE public.hr_pending_employees
  ADD COLUMN IF NOT EXISTS first_name     TEXT,
  ADD COLUMN IF NOT EXISTS last_name      TEXT,
  ADD COLUMN IF NOT EXISTS name_extension TEXT;

-- 2) Backfill hr_onboarding_submissions from full_name ───────────────────────
WITH parsed AS (
  SELECT
    id,
    arr,
    array_length(arr, 1) AS n,
    lower(arr[array_length(arr, 1)]) AS last_tok
  FROM (
    SELECT
      id,
      regexp_split_to_array(btrim(regexp_replace(full_name, '\s+', ' ', 'g')), ' ') AS arr
    FROM public.hr_onboarding_submissions
    WHERE full_name IS NOT NULL AND btrim(full_name) <> ''
  ) s
),
peeled AS (
  SELECT
    id,
    arr,
    CASE
      WHEN n >= 3 AND last_tok IN ('jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv')
      THEN arr[n]
    END AS ext,
    CASE
      WHEN n >= 3 AND last_tok IN ('jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv')
      THEN n - 1
      ELSE n
    END AS eff_n
  FROM parsed
)
UPDATE public.hr_onboarding_submissions t
SET
  first_name     = p.arr[1],
  last_name      = CASE WHEN p.eff_n >= 2 THEN array_to_string(p.arr[2:p.eff_n], ' ') END,
  name_extension = p.ext
FROM peeled p
WHERE t.id = p.id
  AND t.first_name IS NULL;   -- don't clobber rows already split

-- 3) Backfill hr_pending_employees from name ─────────────────────────────────
WITH parsed AS (
  SELECT
    id,
    arr,
    array_length(arr, 1) AS n,
    lower(arr[array_length(arr, 1)]) AS last_tok
  FROM (
    SELECT
      id,
      regexp_split_to_array(btrim(regexp_replace(name, '\s+', ' ', 'g')), ' ') AS arr
    FROM public.hr_pending_employees
    WHERE name IS NOT NULL AND btrim(name) <> ''
  ) s
),
peeled AS (
  SELECT
    id,
    arr,
    CASE
      WHEN n >= 3 AND last_tok IN ('jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv')
      THEN arr[n]
    END AS ext,
    CASE
      WHEN n >= 3 AND last_tok IN ('jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv')
      THEN n - 1
      ELSE n
    END AS eff_n
  FROM parsed
)
UPDATE public.hr_pending_employees t
SET
  first_name     = p.arr[1],
  last_name      = CASE WHEN p.eff_n >= 2 THEN array_to_string(p.arr[2:p.eff_n], ' ') END,
  name_extension = p.ext
FROM peeled p
WHERE t.id = p.id
  AND t.first_name IS NULL;

-- Verify ─────────────────────────────────────────────────────────────────────
SELECT 'hr_onboarding_submissions' AS tbl, full_name, first_name, last_name, name_extension
FROM public.hr_onboarding_submissions
WHERE full_name IS NOT NULL
ORDER BY created_at DESC
LIMIT 20;

SELECT 'hr_pending_employees' AS tbl, name, first_name, last_name, name_extension
FROM public.hr_pending_employees
ORDER BY created_at DESC
LIMIT 20;
