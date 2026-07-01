-- ============================================================================
-- HR New Hire Checklist — per-cell EDIT HISTORY (2026-07-01, migration #94)
--
-- Adds a single JSONB column holding an append-only edit log per DATA column:
--   {
--     "name": [
--       {"by":"hr@simple.biz","at":"2026-06-30T09:12:00Z","from":null,"to":"Jon Cruz"},
--       {"by":"carla@simple.biz","at":"2026-07-01T14:03:00Z","from":"Jon Cruz","to":"Jan Cruz"}
--     ],
--     ...
--   }
-- Each entry = who changed the cell, when, and the old -> new value. Only
-- columns edited at least once appear as keys; a brand-new blank row is '{}'.
-- The app caps each column's log to the most recent 50 entries.
--
-- Populated server-side in syncHrNewHireChecklist (src/lib/supabase/
-- hr-new-hire-checklist.ts): on every save it diffs each incoming field
-- against the value CURRENTLY in the database (not against whatever the client
-- happened to have loaded), so the log is correct even if two people have the
-- grid open at once. JSONB is schemaless, so the column itself is all that's
-- needed here — the log shape lives entirely in app code.
--
-- Idempotent: safe to re-run.
-- ============================================================================

BEGIN;

ALTER TABLE public.hr_new_hire_checklist
  ADD COLUMN IF NOT EXISTS cell_edits jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMIT;

-- Verify:
--   SELECT id, name, jsonb_pretty(cell_edits) FROM public.hr_new_hire_checklist
--     WHERE cell_edits <> '{}'::jsonb LIMIT 20;
