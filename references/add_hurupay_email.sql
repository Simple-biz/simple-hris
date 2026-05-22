-- ============================================================================
-- Add hurupay_email to hr_onboarding_submissions
-- Generated: 2026-05-22
--
-- Purpose
--   Let the new hire set the email tied to their Hurupay account, rather than
--   forcing it to be their personal email. The onboarding form pre-fills this
--   with the personal email as a suggestion, but the hire can change it.
-- ============================================================================

ALTER TABLE public.hr_onboarding_submissions
  ADD COLUMN IF NOT EXISTS hurupay_email TEXT;

COMMENT ON COLUMN public.hr_onboarding_submissions.hurupay_email IS
  'Email the new hire uses for their Hurupay account (set on Step 5 when payment_method = hurupay). Pre-filled with the personal email as a suggestion but editable.';

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'hr_onboarding_submissions'
  AND column_name = 'hurupay_email';
