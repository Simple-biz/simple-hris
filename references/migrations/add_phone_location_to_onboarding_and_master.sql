-- Migration: add location to hr_onboarding_submissions
--            add Phone Number + Location to global_master_list
--
-- Run in Supabase SQL editor.

-- 1. Onboarding submissions: store the location new hires enter on the form.
ALTER TABLE hr_onboarding_submissions
  ADD COLUMN IF NOT EXISTS location TEXT;

-- 2. Global master list: columns that promote now writes into.
--    Column names use the same mixed-case convention as the rest of the table.
ALTER TABLE global_master_list
  ADD COLUMN IF NOT EXISTS "Phone Number" TEXT,
  ADD COLUMN IF NOT EXISTS "Location" TEXT;
