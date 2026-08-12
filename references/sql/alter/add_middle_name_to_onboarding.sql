-- Middle name on the onboarding paperwork.
--
-- Adds `middle_name` to BOTH tables the structured name parts live on, beside
-- the first_name / last_name / name_extension columns added by
-- references/sql/migrate/2026-07-20_split_onboarding_name_columns.sql.
--
-- DELIBERATELY NOT part of the composed name. `hr_onboarding_submissions
-- .full_name` and `hr_pending_employees.name` stay "First Last [Extension]":
-- they feed the master-list "Name" column, payroll name-matching and the
-- surname-first display trigger (public.name_last_first_quoted), whose go-by
-- rule takes the LAST given token — folding a middle name in would rename
-- "Jane Marie Santos" to `Santos, Jane Marie "Marie"` everywhere the Payroll
-- Wizard prints her. See docs/features/onboarding-name-parts.md.
--
-- Consequently there is NO backfill: a middle name was never captured, so it
-- cannot be recovered from full_name. Existing rows keep NULL until the hire
-- re-opens their paperwork and fills the box.
--
-- Idempotent (IF NOT EXISTS) and transactional — safe to re-run.
-- Apply with: node scripts/apply-middle-name-columns.mjs

BEGIN;

ALTER TABLE public.hr_onboarding_submissions
  ADD COLUMN IF NOT EXISTS middle_name TEXT;

ALTER TABLE public.hr_pending_employees
  ADD COLUMN IF NOT EXISTS middle_name TEXT;

COMMENT ON COLUMN public.hr_onboarding_submissions.middle_name IS
  'Middle name as typed on the onboarding paperwork. HR record only: never composed into full_name and never used for work-email / gmail-surname / CallTools derivation.';

COMMENT ON COLUMN public.hr_pending_employees.middle_name IS
  'Middle name carried over from the linked onboarding submission. HR record only: never composed into name.';

COMMIT;

-- Verify:
--   SELECT table_name, column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_schema = 'public'
--      AND table_name IN ('hr_onboarding_submissions', 'hr_pending_employees')
--      AND column_name = 'middle_name'
--    ORDER BY table_name;
