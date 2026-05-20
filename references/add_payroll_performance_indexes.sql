-- Payroll Wizard load-performance indexes.
--
-- Measured 2026-05-20 (from a fast PH link to Supabase; Vercel US->Singapore is
-- several times slower):
--   * hubstaff_hours filtered by source_file: ~886ms for 764 of 22,635 rows
--     (a FILTERED count was slower than an UNFILTERED count -> sequential scan,
--     i.e. no usable index on source_file). The Initial Calculation fetches the
--     current week's file, and the PAB month-merge fans out one fetch PER file
--     (13 files = ~13 full scans).
--   * employee_hourly_rates_current view page: ~1066ms (the DISTINCT ON over the
--     base table sorts on lower(trim(email)) with no matching index).
--   * active_employees: ~1010ms (filters global_master_list by last_seen_upload_id).
--
-- All CREATE INDEX IF NOT EXISTS -> safe, idempotent, non-destructive. Run once in
-- the Supabase SQL editor. Use CONCURRENTLY in prod if you want to avoid locking
-- (cannot run CONCURRENTLY inside a transaction block).

-- 1. hubstaff_hours: the big one. Every /api/hubstaff-hours?source_file= fetch and
--    the current-upload filter hit these columns.
create index if not exists idx_hubstaff_hours_source_file
  on public.hubstaff_hours (source_file);
create index if not exists idx_hubstaff_hours_upload_id
  on public.hubstaff_hours (upload_id);

-- 2. employee_hourly_rates: match the DISTINCT ON ... ORDER BY expressions in the
--    employee_hourly_rates_current view so it can index-scan instead of full-sort.
create index if not exists idx_ehr_personal_email_lower
  on public.employee_hourly_rates (lower(trim("Personal Email")), id desc);
create index if not exists idx_ehr_work_email_lower
  on public.employee_hourly_rates (lower(trim("Work Email")), id desc);

-- 3. global_master_list: the active_employees view filters by last_seen_upload_id.
create index if not exists idx_gml_last_seen_upload
  on public.global_master_list (last_seen_upload_id);
