-- Migration: Create app_settings table (idempotent)
-- Created: 2026-06-15
--
-- Global application settings stored as key-value pairs.
-- Used for: webhooks config, workspace license info, auth settings, etc.
--
-- NOTE: `value` is TEXT, not JSONB. Every setting is stored as a JSON *string*
-- (see lib/supabase/app-settings.ts, which types value as string). Readers must
-- JSON.parse() the value. Do NOT switch this to JSONB without migrating all
-- callers, or the app-wide string contract breaks.

CREATE TABLE IF NOT EXISTS public.app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- Drop existing policy if it exists, then create
DROP POLICY IF EXISTS "Admins only" ON public.app_settings;
CREATE POLICY "Admins only" ON public.app_settings
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.employee_roles
      WHERE work_email = auth.jwt()->>'email'
        AND role = 'admin'
        AND revoked_at IS NULL
    )
  );

-- Auto-update the updated_at timestamp on modification
CREATE OR REPLACE FUNCTION public.update_app_settings_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_app_settings_timestamp ON public.app_settings;
CREATE TRIGGER update_app_settings_timestamp
  BEFORE UPDATE ON public.app_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_app_settings_timestamp();
