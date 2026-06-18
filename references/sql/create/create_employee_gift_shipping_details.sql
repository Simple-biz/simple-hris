-- Migration: employee_gift_shipping_details
-- Created: 2026-05-11
--
-- Per-milestone shipping details collected from the employee 30 days before
-- each 6-month tenure milestone. Filled and edited freely by the employee
-- until the Orphanage team approves the row, at which point it locks. A new
-- row is collected at every subsequent milestone (12mo, 18mo, …).
--
-- Keyed by (personal_email lower-cased, milestone_index) so the same employee
-- can have an independent submission per milestone (per-milestone history is
-- preserved for audit). milestone_index = 1 means the first 6-month gift,
-- 2 = the 12-month gift, etc.
--
-- Idempotent: rerunning is safe.

BEGIN;

CREATE TABLE IF NOT EXISTS public.employee_gift_shipping_details (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  personal_email              TEXT NOT NULL,
  milestone_index             INT  NOT NULL CHECK (milestone_index >= 1),
  milestone_date              DATE NOT NULL,
  preferred_delivery_location TEXT NOT NULL DEFAULT '',
  active_contact_number       TEXT NOT NULL DEFAULT '',
  notes                       TEXT NOT NULL DEFAULT '',
  status                      TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by                  TEXT,
  decided_at                  TIMESTAMPTZ,
  decision_note               TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (personal_email, milestone_index)
);

CREATE INDEX IF NOT EXISTS idx_egsd_personal_email
  ON public.employee_gift_shipping_details (personal_email);
CREATE INDEX IF NOT EXISTS idx_egsd_status
  ON public.employee_gift_shipping_details (status);

-- Lowercase the email and bump updated_at on every write.
CREATE OR REPLACE FUNCTION public.employee_gift_shipping_normalize()
RETURNS TRIGGER AS $$
BEGIN
  NEW.personal_email := LOWER(TRIM(NEW.personal_email));
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_egsd_normalize ON public.employee_gift_shipping_details;
CREATE TRIGGER trg_egsd_normalize
  BEFORE INSERT OR UPDATE ON public.employee_gift_shipping_details
  FOR EACH ROW EXECUTE FUNCTION public.employee_gift_shipping_normalize();

COMMIT;
