-- Migration: gift assignment columns on employee_gift_shipping_details
-- Created: 2026-05-11
--
-- When the Orphanage team approves a shipping submission, they also assign
-- the gift that goes with that milestone (picked from gift_catalog.items)
-- along with its PHP price. This data is what Accounting consumes in their
-- weekly outflow rollup.
--
-- Idempotent: rerunning is safe.

BEGIN;

ALTER TABLE public.employee_gift_shipping_details
  ADD COLUMN IF NOT EXISTS gift_catalog_item_id TEXT,
  ADD COLUMN IF NOT EXISTS gift_name            TEXT,
  ADD COLUMN IF NOT EXISTS gift_price_php       NUMERIC(12,2);

-- Index on decided_at so the Accounting query (filter by approval date in PAB
-- month) doesn't need to scan the whole table.
CREATE INDEX IF NOT EXISTS idx_egsd_decided_at
  ON public.employee_gift_shipping_details (decided_at);

-- Add the table to the supabase_realtime publication so the Accounting
-- Payroll Wizard can subscribe to approvals and refresh the Tenure Gifts
-- tab in real time. Wrapped so re-running can't error if it's already there.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.employee_gift_shipping_details;
EXCEPTION
  WHEN duplicate_object THEN
    -- Already in the publication; nothing to do.
    NULL;
  WHEN undefined_object THEN
    -- supabase_realtime publication doesn't exist on this database; skip silently.
    NULL;
END $$;

COMMIT;
