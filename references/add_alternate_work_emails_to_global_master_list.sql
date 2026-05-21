-- Migration: alternate work emails on global_master_list
-- ----------------------------------------------------------------------------
-- The master Google Sheet gained two new columns (F and G) holding "Alternate
-- Work Email" addresses. These are extra gsuite aliases an employee may carry
-- once promoted (most commonly the PM team) so they can present a real-name
-- address to customers; mail to those aliases still lands in their primary
-- work inbox. We persist both so the accounting Rates & Profiles dashboard can
-- display them and so any record keyed on an alternate address resolves back
-- to the same person.
--
-- The sheet sync maps CSV columns to DB columns by header name. These two
-- column names match the header text the sheet uses. If the sheet headers the
-- two columns identically ("Alternate Work Email" twice), the ingest maps them
-- positionally to these two slots (see resolveMasterColumnMapping in
-- src/lib/supabase/global-master-list-db.ts).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE VIEW. Safe to re-run.

ALTER TABLE public.global_master_list
  ADD COLUMN IF NOT EXISTS "Alternate Work Email"   TEXT,
  ADD COLUMN IF NOT EXISTS "Alternate Work Email 2" TEXT;

-- Recreate active_employees so PostgREST exposes the new columns. Definition
-- mirrors references/global_master_list_offboarded_columns.sql.
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
  AND column_name LIKE 'Alternate Work Email%'
ORDER BY ordinal_position;
