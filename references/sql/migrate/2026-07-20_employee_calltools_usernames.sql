-- Migration: employee_calltools_usernames — per-employee CallTools dialer
-- username store (backfill + manual override), keyed by normalized email.
--
-- Why this exists (see docs/features/onboarding-calltools-username.md):
--   The onboarding submission is the AUTO source of a Lead Gen hire's CallTools
--   username (minted at submit). But that only covers people who onboarded
--   THROUGH that feature — most current Lead Gen staff predate it, and ~94 of the
--   ~217 active Lead Gen employees have no onboarding submission at all, so there
--   is nowhere on a submission to record their username. This table is the
--   editable, per-person record the Manager -> My Team roster reads and writes:
--   inline edits and the bulk importer (scripts/import-calltools-usernames.mjs)
--   both upsert here.
--
--   The roster read (loadCallToolsUsernamesByEmail) overlays this table ON TOP OF
--   the submission-derived value, so a manual entry here WINS over a stale minted
--   one. Keyed by the employee's work email (personal-email fallback), lower-cased
--   and trimmed, matching how the roster join looks employees up.
--
-- Idempotent; run in the Supabase SQL editor.

CREATE TABLE IF NOT EXISTS employee_calltools_usernames (
  email              TEXT PRIMARY KEY,
  calltools_username TEXT NOT NULL,
  -- Denormalized roster name at write time — display/debug only, never a join key.
  name               TEXT,
  updated_by         TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE employee_calltools_usernames IS
  'Per-employee CallTools dialer username (manual backfill / override). Keyed by normalized email; overlays the onboarding-submission value on the Manager My Team roster.';
