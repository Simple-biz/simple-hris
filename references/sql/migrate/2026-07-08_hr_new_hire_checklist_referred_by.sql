-- ============================================================================
-- New Hire Checklist: add `referred_by` column  (2026-07-08, migration #106)
--
-- Captures WHO referred a hire, sitting beside the `source` column. When a
-- hire's source is a referral ("Referral", "Employee Referral", …) the
-- "Referred By" value is REQUIRED — enforced in the quick-add modal and flagged
-- in the grid. Plain TEXT like every other checklist column so a paste never
-- fails on formatting. Idempotent + safe to re-run.
--
-- NOTE: run this BEFORE (or with) deploying the app change — the grid save path
-- writes every field in HR_NEW_HIRE_CHECKLIST_FIELDS (now including
-- `referred_by`), so a save would error until this column exists.
-- ============================================================================

BEGIN;

ALTER TABLE public.hr_new_hire_checklist
  ADD COLUMN IF NOT EXISTS referred_by text;

COMMIT;

-- Verify:
--   SELECT name, source, referred_by
--     FROM public.hr_new_hire_checklist
--    WHERE source ILIKE '%refer%'
--    ORDER BY created_at DESC
--    LIMIT 20;
