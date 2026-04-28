-- ============================================================
-- Sync trigger: payment_dispatches → disbursement_records
--
-- Whenever Lenny logs a payment via Mark Paid, the corresponding
-- disbursement_records row's status / paid_amount_usd / dispatch_id
-- updates in place — so the Reports tab stays accurate without
-- re-running the seed.
--
-- Match key: (cycle_source_file, recipient_email)
--
-- Idempotent — drops + recreates trigger functions.
-- Run after `seed_disbursement_records.sql`.
-- ============================================================

BEGIN;

-- INSERT / UPDATE on payment_dispatches → write through to disbursement_records.
CREATE OR REPLACE FUNCTION public.sync_disbursement_from_dispatch()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.disbursement_records dr
  SET
    status          = NEW.status,
    paid_amount_usd = CASE WHEN NEW.status = 'paid' THEN NEW.amount_usd ELSE NULL END,
    paid_at         = CASE WHEN NEW.status = 'paid' THEN NEW.sent_date ELSE NULL END,
    bank_used       = NEW.bank_used,
    transaction_id  = NEW.transaction_id,
    dispatch_id     = NEW.id,
    updated_at      = now()
  WHERE dr.source_file = NEW.cycle_source_file
    AND LOWER(dr.recipient_email) = LOWER(NEW.recipient_email);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_dispatches_sync_disbursement ON public.payment_dispatches;
CREATE TRIGGER payment_dispatches_sync_disbursement
  AFTER INSERT OR UPDATE ON public.payment_dispatches
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_disbursement_from_dispatch();


-- DELETE on payment_dispatches → revert disbursement_records to pending.
CREATE OR REPLACE FUNCTION public.unsync_disbursement_from_dispatch()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.disbursement_records dr
  SET
    status          = 'pending',
    paid_amount_usd = NULL,
    paid_at         = NULL,
    bank_used       = NULL,
    transaction_id  = NULL,
    dispatch_id     = NULL,
    updated_at      = now()
  WHERE dr.dispatch_id = OLD.id;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_dispatches_unsync_disbursement ON public.payment_dispatches;
CREATE TRIGGER payment_dispatches_unsync_disbursement
  AFTER DELETE ON public.payment_dispatches
  FOR EACH ROW
  EXECUTE FUNCTION public.unsync_disbursement_from_dispatch();


-- One-time backfill so any existing payment_dispatches rows are reflected.
-- (No-op for fresh installs.)
UPDATE public.disbursement_records dr
SET
  status          = pd.status,
  paid_amount_usd = CASE WHEN pd.status = 'paid' THEN pd.amount_usd ELSE NULL END,
  paid_at         = CASE WHEN pd.status = 'paid' THEN pd.sent_date ELSE NULL END,
  bank_used       = pd.bank_used,
  transaction_id  = pd.transaction_id,
  dispatch_id     = pd.id,
  updated_at      = now()
FROM public.payment_dispatches pd
WHERE dr.source_file = pd.cycle_source_file
  AND LOWER(dr.recipient_email) = LOWER(pd.recipient_email);

COMMIT;
