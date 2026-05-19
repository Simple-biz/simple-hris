-- ============================================================================
-- HR Onboarding form submissions — `hr_onboarding_submissions`
-- Generated: 2026-05-19
--
-- Purpose
--   Public, token-based onboarding form (modeled after the Formsite version
--   the company used externally). HR generates a shareable link from the HR
--   Dashboard → Onboarding → Onboarding Form sub-tab; the new hire opens the
--   link, fills in their info across 6 steps (personal info, non-solicitation
--   agreement, privacy agreement, W-8BEN upload, payment method/bank details,
--   contract worker agreement), and submits.
--
-- Token model
--   Each row is created in `pending` status with a long random `token`. The
--   public form route (/onboarding/[token]) loads the row by token; on submit
--   the row flips to `submitted` and the form data fields are populated.
--   HR (elevated) can list/view submissions from the dashboard.
--
-- Storage
--   The W-8BEN PDF (when uploaded by non-US contractors) is stored in the
--   `hr-onboarding-files` bucket under `<submission_id>/w8ben.pdf`. The path
--   is recorded in `w8ben_file_path` so HR can fetch a signed URL on demand.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.hr_onboarding_submissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token           TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'submitted', 'archived')),

  -- Provenance ────────────────────────────────────────────────────────────
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      TEXT,                          -- HR user email that generated the link
  submitted_at    TIMESTAMPTZ,

  -- Invite metadata (filled when HR generates the link, used to seed the form)
  invite_name             TEXT,                  -- pre-filled name shown to the hire
  invite_personal_email   TEXT,                  -- who the link was issued to
  invite_department       TEXT,
  invite_note             TEXT,

  -- Step 1 — personal info ────────────────────────────────────────────────
  full_name       TEXT,
  phone           TEXT,
  email           TEXT,

  -- Step 2 — non-solicitation signature (base64 PNG data URL) ─────────────
  non_solicitation_signature  TEXT,

  -- Step 3 — privacy agreement signature ─────────────────────────────────
  privacy_signature           TEXT,

  -- Step 4 — W-8BEN tax form upload ──────────────────────────────────────
  w8ben_applicable    BOOLEAN,                   -- false = US-based, skipped
  w8ben_file_path     TEXT,                      -- storage path inside hr-onboarding-files bucket
  w8ben_file_name     TEXT,                      -- original filename for HR display

  -- Step 5 — payment method + wire details ───────────────────────────────
  payment_method      TEXT CHECK (payment_method IN ('hurupay', 'wires')),
  bank_full_name      TEXT,
  bank_account_name   TEXT,
  bank_account_number TEXT,
  bank_swift_code     TEXT,
  bank_street         TEXT,
  bank_city           TEXT,
  bank_province       TEXT,
  bank_postal_code    TEXT,
  bank_full_address   TEXT,                      -- re-entered single-cell version per Formsite quirk

  -- Step 6 — contract worker agreement signature + date ──────────────────
  contract_signature  TEXT,
  contract_date       DATE,

  -- Audit / soft-delete ──────────────────────────────────────────────────
  archived_at         TIMESTAMPTZ,
  notes               TEXT
);

CREATE INDEX IF NOT EXISTS hr_onboarding_submissions_status_idx
  ON public.hr_onboarding_submissions (status);
CREATE INDEX IF NOT EXISTS hr_onboarding_submissions_token_idx
  ON public.hr_onboarding_submissions (token);
CREATE INDEX IF NOT EXISTS hr_onboarding_submissions_created_idx
  ON public.hr_onboarding_submissions (created_at DESC);
CREATE INDEX IF NOT EXISTS hr_onboarding_submissions_invite_email_idx
  ON public.hr_onboarding_submissions (LOWER(invite_personal_email));

COMMENT ON TABLE public.hr_onboarding_submissions IS
  'Token-keyed onboarding form submissions from new hires (multi-step form replacement for the prior Formsite onboarding flow).';

-- ─────────────────────────────────────────────────────────────────────────
-- Storage bucket for W-8BEN file uploads. We make it private — HR fetches
-- signed URLs on demand from the dashboard rather than exposing PDFs to the
-- public internet.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('hr-onboarding-files', 'hr-onboarding-files', false)
ON CONFLICT (id) DO NOTHING;

-- Verify ─────────────────────────────────────────────────────────────────
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'hr_onboarding_submissions'
ORDER BY ordinal_position;
