-- ============================================================
-- Migration: per-processor payout fields on employee_ids
-- Purpose:
--   Carla's MEETING-WITH-CARLA.MD specifies different data
--   per processor: Wepay/Hurupay = email, Higlobe = email +
--   account holder, Wise = tag, Jeeves = phone + wire details,
--   Wires = name + account + SWIFT + full address.
--
--   Today these per-processor fields live ONLY on
--   employee_hourly_rates (admin-curated, seeded from CSV).
--   The Settings page now lets the employee fill them in
--   directly — these columns hold the employee-provided
--   values. The dispatch queue prefers these over the
--   rates-side values when present.
-- Run in Supabase SQL editor (Dashboard → SQL Editor).
-- ============================================================

ALTER TABLE public.employee_ids
  ADD COLUMN IF NOT EXISTS hurupay_email        TEXT,
  ADD COLUMN IF NOT EXISTS wepay_email          TEXT,
  ADD COLUMN IF NOT EXISTS higlobe_email        TEXT,
  ADD COLUMN IF NOT EXISTS higlobe_account_name TEXT,
  ADD COLUMN IF NOT EXISTS wise_email           TEXT,
  ADD COLUMN IF NOT EXISTS wise_tag             TEXT,
  ADD COLUMN IF NOT EXISTS phone_number         TEXT,
  ADD COLUMN IF NOT EXISTS swift_code           TEXT,
  ADD COLUMN IF NOT EXISTS full_address         TEXT;

COMMENT ON COLUMN public.employee_ids.hurupay_email IS
  'Email the employee uses on Hurupay. Employee-provided — no work-email fallback.';
COMMENT ON COLUMN public.employee_ids.wepay_email IS
  'Email the employee uses on Wepay. Employee-provided — no work-email fallback.';
COMMENT ON COLUMN public.employee_ids.higlobe_email IS
  'Email the employee uses on HiGlobe.';
COMMENT ON COLUMN public.employee_ids.higlobe_account_name IS
  'Account holder name on HiGlobe (often differs from work name).';
COMMENT ON COLUMN public.employee_ids.wise_email IS
  'Email the employee uses on Wise.';
COMMENT ON COLUMN public.employee_ids.wise_tag IS
  'Wise @tag, optional alternative to wise_email.';
COMMENT ON COLUMN public.employee_ids.phone_number IS
  'Phone number for Jeeves / wire pickups.';
COMMENT ON COLUMN public.employee_ids.swift_code IS
  'SWIFT/BIC code for international wires.';
COMMENT ON COLUMN public.employee_ids.full_address IS
  'Full address for wires + Jeeves.';
