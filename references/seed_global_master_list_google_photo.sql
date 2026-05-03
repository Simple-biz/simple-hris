-- ============================================================================
-- Add google_photo_url column to global_master_list + refresh active_employees
-- view so the column is visible to the API.
-- Generated: 2026-05-02
--
-- Populated by the NextAuth jwt callback on each Google sign-in (see
-- src/lib/auth/auth-options.ts → persistGooglePhoto). Read by Rates & Profiles
-- and any other roster surface that wants to show Google avatars for users
-- who have signed in at least once.
-- ============================================================================

ALTER TABLE public.global_master_list
  ADD COLUMN IF NOT EXISTS google_photo_url TEXT;

-- Refresh active_employees so the new column is exposed via PostgREST.
-- Postgres expands SELECT * at view-creation time; without this, the column
-- exists on the table but not on the view.
CREATE OR REPLACE VIEW public.active_employees AS
SELECT *
FROM public.global_master_list
WHERE last_seen_upload_id = (
  SELECT id FROM public.master_list_uploads WHERE is_current = TRUE LIMIT 1
);

-- Verify
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'active_employees'
  AND column_name = 'google_photo_url';
