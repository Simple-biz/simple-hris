-- Migration: expose "Phone Number" + "Location" (and id) through active_employees
-- ----------------------------------------------------------------------------
-- `global_master_list` already HAS the "Phone Number" and "Location" columns
-- (added by add_phone_location_to_onboarding_and_master.sql) — but that
-- migration did NOT recreate the active_employees view, and a `SELECT *` view
-- in Postgres freezes its column list at creation time. So PostgREST never
-- started exposing those two columns through the view, and the persisted `id`
-- may or may not be present depending on which column-adding migration last
-- recreated the view.
--
-- This recreate re-resolves `SELECT *` against the CURRENT table shape, so the
-- view exposes every column the base table currently has — including
-- "Phone Number", "Location", and id — with no column list to maintain.
--
-- Needed by the People → View Modal profile editor: the roster reads the view
-- (src/lib/supabase/employees.ts → fetchActiveEmployees), and the editor writes
-- back to global_master_list.id / "Phone Number" / "Location".
--
-- Idempotent: CREATE OR REPLACE VIEW only. Safe to re-run. Definition mirrors
-- references/sql/alter/add_employee_id_to_global_master_list.sql.

CREATE OR REPLACE VIEW public.active_employees AS
SELECT *
FROM public.global_master_list
WHERE last_seen_upload_id = (
    SELECT id FROM public.master_list_uploads WHERE is_current = TRUE LIMIT 1
  )
  AND off_boarded_at IS NULL;

-- Verify the two columns are now visible through the view.
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'active_employees'
  AND column_name IN ('Phone Number', 'Location', 'id')
ORDER BY column_name;
