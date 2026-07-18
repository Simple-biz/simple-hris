-- Contractor profiles: US ACH rail (the invoice "US" region payment method).
-- Stored as discrete columns alongside the existing payout fields; prefills the
-- ACH details onto new USD invoices.
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS ach_account_holder  TEXT;
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS ach_bank_name       TEXT;
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS ach_account_number  TEXT;
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS ach_routing_number  TEXT;
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS ach_account_type    TEXT;
