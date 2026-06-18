-- Staged orphanage dispute workflow: extend allowed status values + migrate rows.
-- Run once after deploying code that reads/writes these statuses.
--
-- The table has CHECK (status IN (...)). New enums must be added before UPDATEs.

ALTER TABLE public.pab_day_disputes
  DROP CONSTRAINT IF EXISTS pab_day_disputes_status_check;

ALTER TABLE public.pab_day_disputes
  ADD CONSTRAINT pab_day_disputes_status_check
  CHECK (status IN (
    'pending',
    'pending_orphanage_manager',
    'orphanage_manager_approved',
    'orphanage_manager_denied',
    'approved',
    'denied',
    'accounting_approved',
    'accounting_denied'
  ));

-- 1) Employee-filed orphanage_visit rows awaiting the Orphanage Manager
UPDATE public.pab_day_disputes
SET status = 'pending_orphanage_manager'
WHERE reason = 'orphanage_visit' AND status = 'pending';

-- 2) Orphanage visits that already had final Accounting approval under the old single "approved" label
UPDATE public.pab_day_disputes
SET status = 'accounting_approved'
WHERE reason = 'orphanage_visit' AND status = 'approved';

-- Non-orphanage disputes keep status in (pending, approved, denied).
