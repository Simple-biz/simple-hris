-- ============================================================================
-- HR New Hire Checklist — per-cell "last edited by" attribution (2026-07-01,
-- migration #94)
--
-- Adds a single JSONB column that tracks, per DATA column, who last changed
-- that specific cell and when:
--   { "name": {"by": "carla@simple.biz", "at": "2026-07-01T14:03:00.000Z"},
--     "department": {"by": "hr@simple.biz", "at": "2026-06-30T09:12:00.000Z"},
--     ... }
-- Only columns that have actually been edited at least once appear as keys —
-- a brand-new blank row has cell_edits = '{}'.
--
-- Populated server-side in syncHrNewHireChecklist (src/lib/supabase/
-- hr-new-hire-checklist.ts): on every save it diffs each incoming field
-- against the value CURRENTLY in the database (not against whatever the
-- client happened to have loaded), so attribution is correct even if two
-- people have the grid open at once. Unrelated diff logic — no schema
-- change needed beyond this column.
--
-- Idempotent: safe to re-run.
-- ============================================================================

BEGIN;

ALTER TABLE public.hr_new_hire_checklist
  ADD COLUMN IF NOT EXISTS cell_edits jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMIT;

-- Verify:
--   SELECT id, name, cell_edits FROM public.hr_new_hire_checklist
--     WHERE cell_edits <> '{}'::jsonb LIMIT 20;
