-- Migration: split the onboarding Location field into structured parts
--
-- The hire now picks a Country on the paperwork (United States / Philippines /
-- Colombia), which is what tells us their currency (USD / PHP / COP). Currency
-- itself is NOT stored — it is derived from the country in code
-- (src/lib/onboarding/countries.ts), so there is one source of truth.
--
-- The single free-text `location` column is broken down into Street address,
-- City/Municipality, State, Province, Region and Postal code (State/Province/
-- Region are separate because the Philippines uses Region + Province while the
-- US uses State). `location` is KEPT and still populated with a composed
-- "street, city, state, province, region, postal" string on submit, so
-- everything downstream that reads it (promote -> hr_pending_employees.location
-- -> global_master_list."Location") keeps working unchanged.
--
-- Run in Supabase SQL editor.

ALTER TABLE hr_onboarding_submissions
  ADD COLUMN IF NOT EXISTS country               TEXT,
  ADD COLUMN IF NOT EXISTS address_street         TEXT,
  ADD COLUMN IF NOT EXISTS address_city           TEXT,
  ADD COLUMN IF NOT EXISTS address_state          TEXT,
  ADD COLUMN IF NOT EXISTS address_province       TEXT,
  ADD COLUMN IF NOT EXISTS address_region         TEXT,
  ADD COLUMN IF NOT EXISTS address_postal_code    TEXT;
