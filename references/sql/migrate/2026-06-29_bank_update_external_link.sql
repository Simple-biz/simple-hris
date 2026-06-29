-- ============================================================================
-- External Bank-Info Self-Update link  (2026-06-29, migration #91)
--
-- Powers a PUBLIC (no-login) page at /update-bank-info where an employee from
-- the Global Master List types their WORK EMAIL, receives a 6-digit one-time
-- code in that work inbox, then edits the same payout details they filled in
-- during onboarding. Changes land directly in `employee_ids` (the canonical
-- payout source the Accounting/CEO People tab reads).
--
-- This migration adds:
--   1. `bank_update_otps`             — short-lived OTP + post-verification
--                                       session tokens for the public flow.
--   2. `employee_ids.bank_last_self_updated_at` — stamped whenever an employee
--                                       self-updates via the external link, so
--                                       the People tab can flag recent changes.
--
-- Security model (enforced in app code, NOT the DB — service-role bypasses RLS):
--   * OTP codes are stored HASHED (sha256 with a server pepper), never plaintext.
--   * Codes expire after 10 minutes and lock after 5 failed attempts.
--   * A successful verify mints a random `session_token` (20-min TTL); the save
--     endpoint derives the work_email from that token — it never trusts a
--     client-supplied email — closing the salary-redirect hole.
--
-- Idempotent: safe to re-run.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.bank_update_otps (
  id                  uuid        primary key default gen_random_uuid(),
  -- The employee's canonical WORK EMAIL (lowercased). The code is mailed here
  -- and every later step is keyed to this address.
  work_email          text        not null,
  -- sha256(code . work_email . pepper) — the plaintext 6-digit code is never
  -- stored. Compared in constant time at verify.
  code_hash           text        not null,
  attempts            int         not null default 0,
  -- Code validity window (10 minutes from issue).
  expires_at          timestamptz not null,
  -- Set when the code is successfully verified (also closes the code to reuse).
  consumed_at         timestamptz,
  -- Random token returned to the browser after a successful verify; the prefill
  -- + save endpoints accept this instead of re-entering the code.
  session_token       text,
  session_expires_at  timestamptz,
  -- Best-effort source IP (from x-forwarded-for / x-real-ip) for audit.
  request_ip          text,
  created_at          timestamptz not null default now()
);

-- Look up the active code for an email (verify) + throttle recent sends.
CREATE INDEX IF NOT EXISTS bank_update_otps_email_idx
  ON public.bank_update_otps (lower(work_email), created_at DESC);

-- Resolve a post-verification session token (prefill + save).
CREATE INDEX IF NOT EXISTS bank_update_otps_session_idx
  ON public.bank_update_otps (session_token)
  WHERE session_token IS NOT NULL;

-- ── employee_ids: flag external self-updates for the People tab ──────────────
-- Stamped by /api/bank-update/save. The People tab (Accounting + CEO) surfaces
-- "Updated via external link on <date>" so reviewers notice self-service edits.
-- Written best-effort by the app, so an un-migrated env keeps saving bank
-- details (just without the timestamp) rather than failing the whole update.
ALTER TABLE public.employee_ids
  ADD COLUMN IF NOT EXISTS bank_last_self_updated_at timestamptz;

COMMIT;

-- Optional housekeeping — purge fully-expired, unused OTP rows (run anytime):
--   DELETE FROM public.bank_update_otps
--    WHERE consumed_at IS NULL
--      AND expires_at < now() - interval '1 day';
--
-- Verify:
--   SELECT count(*) FROM public.bank_update_otps;
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'employee_ids' AND column_name = 'bank_last_self_updated_at';
