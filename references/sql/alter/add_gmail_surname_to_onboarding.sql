-- Migration: gmail_surname on hr_onboarding_submissions
--
-- The onboarding paperwork now has a "Gmail Surname" field (Step 1 / Welcome).
-- It is the surname the hire's @simple.biz Google (Gmail) account is provisioned
-- with, sent to the create_workspace_account n8n webhook IN PLACE OF the legal
-- last name (set-work-email route). Optional — when blank, the webhook falls
-- back to the last name split from full_name.
--
-- Run in the Supabase SQL editor.

ALTER TABLE hr_onboarding_submissions
  ADD COLUMN IF NOT EXISTS gmail_surname TEXT;
