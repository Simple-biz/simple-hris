-- Contractor profiles: payment details and display names, separate from employee_ids
CREATE TABLE IF NOT EXISTS contractor_profiles (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_email      TEXT NOT NULL UNIQUE,
  display_name          TEXT,
  preferred_processor   TEXT,
  preferred_bank_slot   TEXT DEFAULT 'primary',

  -- Hurupay
  hurupay_email         TEXT,
  -- Wepay
  wepay_email           TEXT,
  -- Higlobe
  higlobe_email         TEXT,
  higlobe_account_name  TEXT,
  -- Wise
  wise_email            TEXT,
  wise_tag              TEXT,
  -- Jeeves / Wire (primary bank)
  phone_number          TEXT,
  full_address          TEXT,
  bank_name             TEXT,
  account_holder_name   TEXT,
  account_number        TEXT,
  swift_code            TEXT,
  -- Alternative bank slot
  alt_bank_name         TEXT,
  alt_account_holder_name TEXT,
  alt_account_number    TEXT,
  alt_routing_number    TEXT,

  -- Invoice "From" details (prefilled in new invoices)
  from_entity_name      TEXT,
  from_name             TEXT,
  from_address          TEXT,
  from_city_state_zip   TEXT,
  from_country          TEXT DEFAULT 'Philippines',

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- If the table already exists without the invoice-from columns, add them:
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS from_entity_name    TEXT;
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS from_name           TEXT;
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS from_address        TEXT;
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS from_city_state_zip TEXT;
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS from_country        TEXT DEFAULT 'Philippines';

-- Keep updated_at current automatically
CREATE OR REPLACE FUNCTION contractor_profiles_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contractor_profiles_updated_at ON contractor_profiles;
CREATE TRIGGER contractor_profiles_updated_at
  BEFORE UPDATE ON contractor_profiles
  FOR EACH ROW EXECUTE FUNCTION contractor_profiles_set_updated_at();

-- Index for email lookups
CREATE INDEX IF NOT EXISTS contractor_profiles_email_idx ON contractor_profiles (contractor_email);
