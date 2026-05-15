-- Migration: persist employee_id on global_master_list
-- Adds the YYMM-NNNN identifier as a real column so it survives roster
-- changes (the old in-memory generateEmployeeIds() re-shuffled numbers
-- whenever a same-month starter joined / left / had their name changed).
-- See memory/project_employee_id_stability.md for the deferred-fix history.
--
-- Backfill is handled by the matching admin route
-- (POST /api/admin/backfill-employee-ids) so we don't have to fight date
-- parsing in SQL — the canonical YYMM extraction lives in
-- src/lib/supabase/employees.ts (`generateEmployeeIds`) and we want this
-- migration to be byte-for-byte compatible with what the UI currently shows.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS
-- + CREATE OR REPLACE VIEW. Safe to re-run.

ALTER TABLE public.global_master_list
  ADD COLUMN IF NOT EXISTS employee_id TEXT;

CREATE INDEX IF NOT EXISTS global_master_list_employee_id_idx
  ON public.global_master_list (employee_id);

-- Recreate the active_employees view so PostgREST exposes the new column.
-- View definition mirrors references/global_master_list_offboarded_columns.sql.
CREATE OR REPLACE VIEW public.active_employees AS
SELECT *
FROM public.global_master_list
WHERE last_seen_upload_id = (
    SELECT id FROM public.master_list_uploads WHERE is_current = TRUE LIMIT 1
  )
  AND off_boarded_at IS NULL;

-- Verify
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'global_master_list'
  AND column_name  = 'employee_id';
