-- Migration: scheduled deletion columns on global_master_list
-- Generated: 2026-05-29
--
-- Why
--   Offboarding now splits by department:
--     * Lead Gen    -> the account is deleted immediately (fire offboarding-delete).
--     * Other depts -> the account is deactivated immediately (fire
--                      offboarding-deactivate) and a 14-day deletion timer is set.
--   `scheduled_deletion_at` is that timer. A daily Vercel cron
--   (/api/cron/process-scheduled-deletions) finds rows whose timer has elapsed
--   and have not yet been processed, fires offboarding-delete, then stamps
--   `deletion_processed_at` so the same row is never deleted twice (Vercel can
--   retry crons; the marker makes the cron idempotent).
--
--   off_boarded_at is still stamped immediately for everyone, so the
--   active_employees view drops them the moment offboard runs regardless of the
--   later hard-delete. These two columns are NOT used by active_employees; the
--   cron queries the base table directly.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE VIEW. Safe to re-run.
-- NOTE: deliberately does NOT backfill existing off-boarded rows -- only NEW
-- offboards get a timer (a backfill would mass-delete historical accounts on the
-- cron's first run).

ALTER TABLE public.global_master_list
  ADD COLUMN IF NOT EXISTS scheduled_deletion_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deletion_processed_at TIMESTAMPTZ;

-- The cron's work queue: rows with an elapsed timer that have not been processed.
-- Partial index keeps it tiny (only pending-deletion rows are indexed).
CREATE INDEX IF NOT EXISTS global_master_list_scheduled_deletion_idx
  ON public.global_master_list (scheduled_deletion_at)
  WHERE scheduled_deletion_at IS NOT NULL AND deletion_processed_at IS NULL;

-- Recreate active_employees so PostgREST exposes the new columns (SELECT * is
-- expanded at creation time). Definition mirrors
-- references/add_alternate_work_emails_to_global_master_list.sql -- unchanged
-- filter: current upload AND not off-boarded.
CREATE OR REPLACE VIEW public.active_employees AS
SELECT *
FROM public.global_master_list
WHERE last_seen_upload_id = (
    SELECT id FROM public.master_list_uploads WHERE is_current = TRUE LIMIT 1
  )
  AND off_boarded_at IS NULL;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'global_master_list'
  AND column_name IN ('scheduled_deletion_at', 'deletion_processed_at')
ORDER BY ordinal_position;
