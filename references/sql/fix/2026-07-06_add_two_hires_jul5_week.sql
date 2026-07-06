-- ============================================================================
-- One-off: add two late hires to the ALREADY-LOCKED Jul 5–11 checklist week
-- as if they went through the New Hire Checklist  (2026-07-06)
--
-- Denmark "Mark" Tacuyan and Arturo Yepes were onboarded AFTER the New Hire
-- Checklist week of Jul 5–11 (period_start = 2026-07-05, a Sunday) was locked
-- in — which already sent the orientation welcome email to that cohort. Both
-- already have their @simple.biz work emails set directly and were handled
-- outside the checklist, so we DO NOT want to re-fire the welcome email.
--
-- The orientation automation only fires from the app's "Lock in" action
-- (PUT action:'lock' -> fireNewHireChecklistLockWebhook). This script only ever
-- INSERT/UPDATEs hr_new_hire_checklist rows and DELIBERATELY NEVER TOUCHES
-- hr_new_hire_checklist_periods, so the week stays 'locked' and NO webhook /
-- email fires.
--
-- STEP 1 inserts the two rows (guarded, so it's a no-op if they already exist).
-- STEP 2 backfills department + phone_number from each hire's onboarding
-- submission (hr_onboarding_submissions, matched on personal email, preferring
-- the SUBMITTED row) so these two match the rest of the Jul 5–11 cohort, which
-- is ~98% complete on those columns. As verified 2026-07-06 both resolve to
-- department "Lead Gen" (phones +639667140440 / +573145939830).
--
-- date_of_interview / source / hired_by are intentionally left NULL — that data
-- is NOT in the onboarding record and is not fabricated here. Fill it from the
-- grid later if the hiring-sources pie / recruiter scorecard need it (these two
-- will otherwise show as "Unspecified" / "unattributed" there).
--
-- Idempotent + re-runnable: the insert has a NOT EXISTS guard on
-- (period_start, personal_email); the backfill only fills a column that is still
-- blank (COALESCE(NULLIF(TRIM(...),''), onboarding value)), so it never clobbers
-- a value later typed into the grid.
-- ============================================================================

BEGIN;

-- ── STEP 1 — insert the two rows if missing (name/email/location/country only) ─
WITH base AS (
  SELECT COALESCE(MAX(position), -1) AS maxpos
    FROM public.hr_new_hire_checklist
   WHERE period_start = DATE '2026-07-05'
),
newrows AS (
  SELECT * FROM (VALUES
    ('Tacuyan, Denmark "Mark"',
     'denmarktacuyan@gmail.com',
     'Trece Martires City, Cavite, CALABARZON (Region IV A)',
     'Philippines',
     1),
    ('Yepes, Arturo "Arturo"',
     'arturoyepes62@yahoo.com',
     'Cali, Colombia (Latin America)',
     'Colombia',
     2)
  ) AS t(name, personal_email, location, country, ord)
)
INSERT INTO public.hr_new_hire_checklist
  (period_start, position, name, personal_email, location, country, created_by)
SELECT
  DATE '2026-07-05',
  base.maxpos + n.ord,
  n.name,
  n.personal_email,
  n.location,
  n.country,
  'kaner@simple.biz'
FROM newrows n CROSS JOIN base
WHERE NOT EXISTS (
  SELECT 1
    FROM public.hr_new_hire_checklist x
   WHERE x.period_start = DATE '2026-07-05'
     AND lower(x.personal_email) = lower(n.personal_email)
);

-- ── STEP 2 — backfill department + phone from each hire's onboarding submission ─
WITH onboard AS (
  SELECT DISTINCT ON (pe) pe, invite_department, phone
    FROM (
      SELECT lower(COALESCE(invite_personal_email, email)) AS pe,
             invite_department,
             phone,
             status,
             submitted_at,
             created_at
        FROM public.hr_onboarding_submissions
       WHERE lower(COALESCE(invite_personal_email, '')) IN
               ('denmarktacuyan@gmail.com', 'arturoyepes62@yahoo.com')
          OR lower(COALESCE(email, '')) IN
               ('denmarktacuyan@gmail.com', 'arturoyepes62@yahoo.com')
    ) s
   ORDER BY pe,
            (status = 'submitted') DESC,          -- prefer the submitted row
            submitted_at DESC NULLS LAST,
            created_at DESC
)
UPDATE public.hr_new_hire_checklist c
   SET department   = COALESCE(NULLIF(TRIM(COALESCE(c.department, '')),   ''), o.invite_department),
       phone_number = COALESCE(NULLIF(TRIM(COALESCE(c.phone_number, '')), ''), o.phone)
  FROM onboard o
 WHERE c.period_start = DATE '2026-07-05'
   AND lower(c.personal_email) = o.pe;

COMMIT;

-- Verify (both should now show department 'Lead Gen' + a phone; no other week touched):
--   SELECT position, name, personal_email, department, phone_number, country, location
--     FROM public.hr_new_hire_checklist
--    WHERE period_start = DATE '2026-07-05'
--      AND lower(personal_email) IN ('denmarktacuyan@gmail.com','arturoyepes62@yahoo.com');
--
-- Confirm the week is STILL locked and untouched (no email side-effect):
--   SELECT * FROM public.hr_new_hire_checklist_periods
--    WHERE period_start = DATE '2026-07-05';
