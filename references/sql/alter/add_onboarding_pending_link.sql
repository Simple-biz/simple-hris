-- ============================================================================
-- Link onboarding submissions <-> pending hires + store the minted work email
-- Generated: 2026-05-20
--
-- Purpose
--   When HR sets a work email on a SUBMITTED onboarding form, we mint the
--   @simple.biz address (auto-suggested from the hire's name) and spin up a
--   matching `hr_pending_employees` row so the hire joins the existing
--   Promote -> global_master_list pipeline. These columns wire the two tables
--   together and let the Onboarding Form list show the minted address + a
--   "converted" badge without a join.
--
--     hr_onboarding_submissions.work_email          -- minted @simple.biz address
--     hr_onboarding_submissions.pending_employee_id -- FK to the staged hire
--     hr_pending_employees.onboarding_submission_id -- provenance back-link;
--                                                      used later to copy the
--                                                      submission's payment
--                                                      details into employee_ids
--                                                      at promote time.
-- ============================================================================

ALTER TABLE public.hr_onboarding_submissions
  ADD COLUMN IF NOT EXISTS work_email          TEXT,
  ADD COLUMN IF NOT EXISTS pending_employee_id BIGINT
    REFERENCES public.hr_pending_employees(id) ON DELETE SET NULL;

ALTER TABLE public.hr_pending_employees
  ADD COLUMN IF NOT EXISTS onboarding_submission_id UUID
    REFERENCES public.hr_onboarding_submissions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS hr_pending_employees_onboarding_submission_idx
  ON public.hr_pending_employees (onboarding_submission_id);

CREATE INDEX IF NOT EXISTS hr_onboarding_submissions_pending_employee_idx
  ON public.hr_onboarding_submissions (pending_employee_id);

-- Verify --------------------------------------------------------------------
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'hr_onboarding_submissions'
       AND column_name IN ('work_email', 'pending_employee_id'))
    OR (table_name = 'hr_pending_employees'
       AND column_name = 'onboarding_submission_id')
  )
ORDER BY table_name, column_name;
