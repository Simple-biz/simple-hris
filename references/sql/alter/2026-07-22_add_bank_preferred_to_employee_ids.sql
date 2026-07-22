-- ============================================================
-- Migration: add bank_preferred to employee_ids
-- Purpose:
--   Employee-facing "Bank Preferred" dropdown on the Profile →
--   Payment tab. This is a SEPARATE field from the Disbursement
--   picker (preferred_processor): the employee picks the processor
--   Payment Dispatch should route their salary through, without
--   changing the Disbursement channel selection.
--
--   Stored as a processor id (x1153 is a wire account → 'wires').
--   Payment Dispatch precedence becomes:
--     employee_ids.bank_preferred          (this column — wins)
--     > employee_ids.preferred_processor   (Disbursement picker)
--     > employee_hourly_rates.bank_preferred (legacy CSV free-text)
-- Run in Supabase SQL editor (Dashboard → SQL Editor).
-- ============================================================

ALTER TABLE public.employee_ids
  ADD COLUMN IF NOT EXISTS bank_preferred TEXT;

-- Constrain to the known processor IDs (the dropdown maps its five
-- labels HiGlobe/Hurupay/Jeeves/Wise/x1153 onto these; x1153 → wires).
-- NULL allowed for employees who haven't picked yet.
ALTER TABLE public.employee_ids
  DROP CONSTRAINT IF EXISTS employee_ids_bank_preferred_chk;

ALTER TABLE public.employee_ids
  ADD CONSTRAINT employee_ids_bank_preferred_chk
  CHECK (
    bank_preferred IS NULL
    OR bank_preferred IN ('hurupay', 'wepay', 'higlobe', 'wise', 'jeeves', 'wires')
  );

COMMENT ON COLUMN public.employee_ids.bank_preferred IS
  'Employee-chosen "Bank Preferred" processor for Payment Dispatch routing. One of: hurupay, wepay, higlobe, wise, jeeves, wires (x1153 → wires). Independent of preferred_processor (the Disbursement channel). Set via the Bank Preferred dropdown on Profile → Payment.';
