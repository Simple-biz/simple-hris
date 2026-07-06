-- ============================================================================
-- One-off: add two late hires to the ALREADY-LOCKED Jul 5–11 checklist week
-- (2026-07-06)
--
-- Denmark "Mark" Tacuyan and Arturo Yepes were onboarded AFTER the New Hire
-- Checklist week of Jul 5–11 (period_start = 2026-07-05, a Sunday) was locked
-- in — which already sent the orientation welcome email to that cohort.
--
-- We want these two in the checklist RECORD for that week WITHOUT re-firing the
-- welcome email to anyone. The orientation automation only fires from the app's
-- "Lock in" action (PUT action:'lock' → fireNewHireChecklistLockWebhook). This
-- script inserts the rows directly and DELIBERATELY DOES NOT TOUCH
-- hr_new_hire_checklist_periods, so the week stays 'locked' and NO webhook /
-- email fires. Email these two manually if they still need an orientation note
-- (the automated one is stale — its orientation date was Mon Jul 6).
--
-- Only the fields provided are set (name / personal_email / location / country).
-- department, phone_number, date_of_interview, source, hired_by are left NULL —
-- fill them later from the grid if needed (department drives Bulk Invite; a
-- blank department means these two won't appear in any dept's Bulk Invite pull).
--
-- Idempotent: the NOT EXISTS guard (period + personal_email) makes a re-run a
-- no-op, and `position` is computed from the current max for the week so the
-- two rows append after the existing ones without colliding.
-- ============================================================================

BEGIN;

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

COMMIT;

-- Verify (should list the two new rows at the bottom of the Jul 5–11 week):
--   SELECT position, name, personal_email, location, country, created_at
--     FROM public.hr_new_hire_checklist
--    WHERE period_start = DATE '2026-07-05'
--    ORDER BY position, created_at;
--
-- Confirm the week is STILL locked and untouched (no email side-effect):
--   SELECT * FROM public.hr_new_hire_checklist_periods
--    WHERE period_start = DATE '2026-07-05';
