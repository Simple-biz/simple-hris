-- Contractor invoice logo snapshot
-- Run once in Supabase SQL editor.
-- Stores the logo that was active when the invoice was created (safe to re-run).

ALTER TABLE contractor_invoices
  ADD COLUMN IF NOT EXISTS logo_data_url TEXT;

COMMENT ON COLUMN contractor_invoices.logo_data_url IS
  'Base64-encoded data URL of the contractor logo at invoice creation time.';
