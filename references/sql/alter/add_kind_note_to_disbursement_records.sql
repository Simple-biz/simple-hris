-- ============================================================
-- disbursement_records: add `kind` + `note` for one-off "special transfers"
--
-- The People tab (Accounting + CEO) can record a one-off payment to an
-- employee — a "special transfer" — that lands in payroll history alongside
-- the regular weekly cycles. These rows are written directly to
-- disbursement_records (the payment_dispatches sync trigger only UPDATEs an
-- already-existing (source_file, recipient_email) row, so a brand-new synthetic
-- source_file would otherwise never appear here).
--
--   kind  : 'cycle'  = a normal weekly payroll row (seeded from a Hubstaff upload)
--           'special' = a one-off special transfer recorded from the People tab
--   note  : free-text reason for a special transfer (NULL for normal cycles)
--
-- Idempotent. Safe to re-run.
-- ============================================================

BEGIN;

ALTER TABLE public.disbursement_records
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'cycle',
  ADD COLUMN IF NOT EXISTS note TEXT;

-- Constrain to the two known kinds (drop+recreate so a re-run stays clean).
ALTER TABLE public.disbursement_records
  DROP CONSTRAINT IF EXISTS disbursement_records_kind_check;
ALTER TABLE public.disbursement_records
  ADD CONSTRAINT disbursement_records_kind_check
  CHECK (kind IN ('cycle', 'special'));

-- Speeds up the per-employee payroll history query (People detail + employee portal).
CREATE INDEX IF NOT EXISTS disbursement_records_recipient_email_idx
  ON public.disbursement_records (LOWER(recipient_email));

COMMIT;
