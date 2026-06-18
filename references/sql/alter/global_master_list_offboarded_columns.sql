-- ============================================================================
-- Off-board columns on global_master_list + active_employees view update
-- Generated: 2026-05-08
--
-- Purpose
--   The HR Dashboard's "Offboard" action marks an employee as off-boarded by
--   setting these four columns on their master-list row. The active_employees
--   view is updated to filter them out, so payroll, manager, orphanage, and
--   every other downstream surface immediately stops seeing them.
--
--   Off-boarded rows are NOT deleted — Carla / Teal want the history retained
--   for attrition reporting and "did we actually off-board this person?"
--   audits. A future Reports tab can read off_boarded_reason for trends.
-- ============================================================================

ALTER TABLE public.global_master_list
  ADD COLUMN IF NOT EXISTS off_boarded_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS off_boarded_reason  TEXT,
  ADD COLUMN IF NOT EXISTS off_boarded_by      TEXT,
  ADD COLUMN IF NOT EXISTS off_boarded_note    TEXT;

CREATE INDEX IF NOT EXISTS global_master_list_off_boarded_at_idx
  ON public.global_master_list (off_boarded_at);

-- Reason taxonomy is enforced by the API (POST /api/hr/offboard) rather than
-- a CHECK constraint so HR can extend it without a migration. Today's set:
--   resigned · performance · time_manipulation · attendance ·
--   end_of_contract · other
-- "other" requires a free-text note on the API side.

-- ── active_employees view: now also excludes off-boarded rows ──────────────
-- Previous definition (per seed_global_master_list_google_photo.sql):
--   WHERE last_seen_upload_id = (
--     SELECT id FROM public.master_list_uploads WHERE is_current = TRUE LIMIT 1
--   )
-- We add `AND off_boarded_at IS NULL` so the moment HR fires Offboard, the
-- person disappears from every dashboard reading from this view.
CREATE OR REPLACE VIEW public.active_employees AS
SELECT *
FROM public.global_master_list
WHERE last_seen_upload_id = (
    SELECT id FROM public.master_list_uploads WHERE is_current = TRUE LIMIT 1
  )
  AND off_boarded_at IS NULL;

-- Verify ────────────────────────────────────────────────────────────────────
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'global_master_list'
  AND column_name LIKE 'off_boarded_%'
ORDER BY ordinal_position;
