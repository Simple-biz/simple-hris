-- Contractor profile logo
-- Run once in Supabase SQL editor.
-- Adds logo_data_url column to contractor_profiles (stores base64 data URL, safe to re-run).

ALTER TABLE contractor_profiles
  ADD COLUMN IF NOT EXISTS logo_data_url TEXT;

COMMENT ON COLUMN contractor_profiles.logo_data_url IS
  'Base64-encoded data URL of the contractor company logo. Prefilled into new invoices.';
