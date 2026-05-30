-- Migration: add 'no_show' status to hr_pending_employees
-- Generated: 2026-05-29
--
-- Why
--   Managers can now mark a staged hire as "Did not attend orientation" from
--   their Newly Hired panel. That sets status='no_show', which also fires the
--   department-aware account teardown (Lead Gen -> delete now; other depts ->
--   deactivate now + 14-day scheduled deletion).
--
--   The original CREATE TABLE used an inline CHECK that only permits
--   ('pending_work_email','ready','promoted','cancelled'); any UPDATE setting
--   'no_show' fails at the DB until this runs. The inline constraint is
--   auto-named hr_pending_employees_status_check.
--
-- Idempotent: drops the existing constraint (if present) and re-adds it with
-- the widened value set. Safe to re-run.

ALTER TABLE public.hr_pending_employees
  DROP CONSTRAINT IF EXISTS hr_pending_employees_status_check;

ALTER TABLE public.hr_pending_employees
  ADD CONSTRAINT hr_pending_employees_status_check
  CHECK (status IN (
    'pending_work_email',
    'ready',
    'promoted',
    'cancelled',
    'no_show'
  ));

-- Bookkeeping columns mirroring the orientation markers, so the UI can show who
-- marked the no-show and when. Nullable; populated by the no-show route.
ALTER TABLE public.hr_pending_employees
  ADD COLUMN IF NOT EXISTS no_show_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS no_show_by   TEXT,
  ADD COLUMN IF NOT EXISTS no_show_note TEXT;

-- Deletion timer for NON-Lead-Gen no-shows. A never-promoted hire has no
-- global_master_list row, so the 14-day delete timer lives here instead. The
-- scheduled-deletion cron drains both this table and global_master_list. Lead
-- Gen no-shows are deleted immediately (deletion_processed_at stamped at once,
-- scheduled_deletion_at left null).
ALTER TABLE public.hr_pending_employees
  ADD COLUMN IF NOT EXISTS scheduled_deletion_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deletion_processed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS hr_pending_employees_scheduled_deletion_idx
  ON public.hr_pending_employees (scheduled_deletion_at)
  WHERE scheduled_deletion_at IS NOT NULL AND deletion_processed_at IS NULL;

-- Verify
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.hr_pending_employees'::regclass
  AND conname = 'hr_pending_employees_status_check';
