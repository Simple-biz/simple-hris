-- ============================================================
-- Migration: add preferred_bank_slot to employee_ids
-- Purpose:
--   Employees can store both a primary and an alternative bank
--   account on employee_ids. This column records which saved bank
--   Payment Dispatch should treat as the preferred destination.
-- Run in Supabase SQL editor (Dashboard -> SQL Editor).
-- ============================================================

ALTER TABLE public.employee_ids
  ADD COLUMN IF NOT EXISTS preferred_bank_slot TEXT;

ALTER TABLE public.employee_ids
  DROP CONSTRAINT IF EXISTS employee_ids_preferred_bank_slot_chk;

ALTER TABLE public.employee_ids
  ADD CONSTRAINT employee_ids_preferred_bank_slot_chk
  CHECK (
    preferred_bank_slot IS NULL
    OR preferred_bank_slot IN ('primary', 'alternative')
  );

COMMENT ON COLUMN public.employee_ids.preferred_bank_slot IS
  'Which saved bank account Payment Dispatch should prefer: primary or alternative.';
