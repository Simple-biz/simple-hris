-- ============================================================================
-- Intellectual Property Assignment on onboarding submissions
-- Generated: 2026-06-16  (migration #73)
--
-- Purpose
--   New hires now sign an "Intellectual Property Assignment, Talent Release,
--   and Copyright Waiver" as a STANDALONE first document before the rest of the
--   onboarding paperwork. They tick the acknowledgement checkbox and draw their
--   signature at the bottom; the date is auto-stamped with the day they opened
--   the link.
--
--   On submit the server renders a filled PDF (name + signature + date +
--   checked box) and stores it in the `hr-onboarding-files` bucket under
--   `<submission_id>/ip-assignment.pdf`, mirroring the W-8BEN flow. HR fetches a
--   signed URL on demand to view/download it.
--
--     ip_agreement_agreed     -- TRUE once the hire ticks "I have read and understood…"
--     ip_agreement_name       -- name printed on the document (PARTICIPANT block)
--     ip_agreement_signature  -- base64 PNG data URL of the drawn signature
--     ip_agreement_date       -- date the hire opened/signed the link
--     ip_assignment_file_path -- storage path of the generated PDF
--     ip_assignment_file_name -- friendly filename for HR display
-- ============================================================================

ALTER TABLE public.hr_onboarding_submissions
  ADD COLUMN IF NOT EXISTS ip_agreement_agreed     BOOLEAN,
  ADD COLUMN IF NOT EXISTS ip_agreement_name       TEXT,
  ADD COLUMN IF NOT EXISTS ip_agreement_signature  TEXT,
  ADD COLUMN IF NOT EXISTS ip_agreement_date       DATE,
  ADD COLUMN IF NOT EXISTS ip_assignment_file_path TEXT,
  ADD COLUMN IF NOT EXISTS ip_assignment_file_name TEXT;

-- Verify --------------------------------------------------------------------
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'hr_onboarding_submissions'
  AND column_name IN (
    'ip_agreement_agreed',
    'ip_agreement_name',
    'ip_agreement_signature',
    'ip_agreement_date',
    'ip_assignment_file_path',
    'ip_assignment_file_name'
  )
ORDER BY column_name;
