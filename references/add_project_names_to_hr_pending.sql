-- ============================================================================
-- Add project_names to hr_pending_employees
-- Generated: 2026-05-22
--
-- Purpose
--   Persist the Hubstaff project(s) HR picks in the onboarding "Set work email"
--   dialog onto the staged hire, so the Promote button can send them to the
--   hubstaff-invite-user n8n webhook (which requires project_names).
-- ============================================================================

ALTER TABLE public.hr_pending_employees
  ADD COLUMN IF NOT EXISTS project_names JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.hr_pending_employees.project_names IS
  'Hubstaff project names chosen at staging (Set work email dialog). Sent as projectNames to the hubstaff-invite-user webhook on Promote.';

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'hr_pending_employees'
  AND column_name = 'project_names';
