-- ============================================================================
-- Persist the create-workspace-account webhook outcome on onboarding submissions
-- Generated: 2026-06-15  (migration #70)
--
-- Purpose
--   When HR sets a work email on a SUBMITTED onboarding form, the route fires
--   the best-effort n8n `create_workspace_account` webhook (Google Workspace +
--   Hubstaff invite + Roboform/overview emails). Until now the webhook result
--   was only written to audit_log + shown in a transient toast, so on reload a
--   hire whose automation FAILED looked identical to one that succeeded -- the
--   minted address was stored either way. HR could not tell which hires actually
--   got provisioned.
--
--   These columns persist the outcome so the Onboarding Form > Submitted tab can
--   show a "Designated Work Email" only when the webhook returned a 200, and a
--   loud "Automation failed - retry" state otherwise.
--
--     workspace_account_ok      -- TRUE  = webhook returned 2xx (designated)
--                                  FALSE = webhook returned an error / no fire
--                                  NULL  = never attempted / legacy row (unknown)
--     workspace_account_status  -- raw HTTP status from the webhook (debugging)
--     workspace_account_error   -- friendly error message when it failed
--     workspace_account_at      -- when the webhook was last attempted
-- ============================================================================

ALTER TABLE public.hr_onboarding_submissions
  ADD COLUMN IF NOT EXISTS workspace_account_ok     BOOLEAN,
  ADD COLUMN IF NOT EXISTS workspace_account_status SMALLINT,
  ADD COLUMN IF NOT EXISTS workspace_account_error  TEXT,
  ADD COLUMN IF NOT EXISTS workspace_account_at      TIMESTAMPTZ;

-- Verify --------------------------------------------------------------------
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'hr_onboarding_submissions'
  AND column_name IN (
    'workspace_account_ok',
    'workspace_account_status',
    'workspace_account_error',
    'workspace_account_at'
  )
ORDER BY column_name;
