-- ============================================================
-- Migration: add preferred_processor to employee_ids
-- Purpose:
--   Carla's request from MEETING-WITH-CARLA.MD — employees must
--   pick from a constrained list of payment processors (Hurupay,
--   Wepay, Higlobe, Wise, Jeeves, Wires) instead of free-typing
--   "GCash" / "digital wallet" / etc. into the Bank Preferred
--   field that Lenny's dispatch queue routes on.
--
--   This column is the employee-facing source of truth. The
--   dispatch queue continues reading employee_hourly_rates.bank_preferred
--   for now; a follow-up migration will sync the two.
-- Run in Supabase SQL editor (Dashboard → SQL Editor).
-- ============================================================

ALTER TABLE public.employee_ids
  ADD COLUMN IF NOT EXISTS preferred_processor TEXT;

-- Constrain to the known processor IDs so a typo or stale UI
-- can't sneak "gcash" in. Matches src/components/payroll-clerk/mock-queue.ts
-- ProcessorId. NULL allowed for employees who haven't picked yet.
ALTER TABLE public.employee_ids
  DROP CONSTRAINT IF EXISTS employee_ids_preferred_processor_chk;

ALTER TABLE public.employee_ids
  ADD CONSTRAINT employee_ids_preferred_processor_chk
  CHECK (
    preferred_processor IS NULL
    OR preferred_processor IN ('hurupay', 'wepay', 'higlobe', 'wise', 'jeeves', 'wires')
  );

COMMENT ON COLUMN public.employee_ids.preferred_processor IS
  'Employee-chosen payment processor. One of: hurupay, wepay, higlobe, wise, jeeves, wires. Set via Employee Settings page.';
