-- MESA Program membership flag
-- Run once in Supabase SQL editor.
-- Adds mesa_member column to employee_hourly_rates (defaults false, safe to re-run).

ALTER TABLE employee_hourly_rates
  ADD COLUMN IF NOT EXISTS mesa_member boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN employee_hourly_rates.mesa_member IS
  'MESA Program member flag. When true, ₱100 is deducted from every paycheck.';
