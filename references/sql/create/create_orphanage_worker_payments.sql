-- Migration: orphanage_worker_payments  (#95)
-- Created: 2026-07-01
--
-- TEMPORARY home for paying orphanage staff who have NO Hubstaff record and NO
-- employee identity — the carpenters / handymen who build & repair the orphanage
-- and the musicians who play there. Accounting adds them + sets their pay right
-- inside the Payment Dispatch → Orphanage tab (see OrphanageQueue.tsx). Each row
-- is a name + amount + category the clerk can pay like any other orphanage item.
--
-- Lifecycle mirrors orphanage_budget_requests / employee_gift_shipping_details:
-- this table is the SOURCE. A pending worker payment shows in the Orphanage
-- queue until an orphanage_dispatches row references it (worker_payment_id) —
-- then it drops out and flows into the Orphanage Reports/Done tabs like every
-- other paid orphanage item. No employee/email/paystub is ever involved.
--
-- Eventual plan (not this migration): worker management moves to the Orphanage
-- Dashboard and the Payroll Wizard picks it up from there.
--
-- Idempotent: safe to re-run (IF NOT EXISTS / OR REPLACE / DROP … IF EXISTS).

BEGIN;

CREATE TABLE IF NOT EXISTS public.orphanage_worker_payments (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  recipient_name      TEXT          NOT NULL,                       -- e.g. "Joji Arancis"
  worker_type         TEXT          NOT NULL DEFAULT 'other'
                                    CHECK (worker_type IN ('handyman', 'musician', 'other')),
  type_label          TEXT,                                         -- free-text label when worker_type = 'other'

  pay_week            TEXT,                                         -- informational period label ("Jun 8–14")
  amount_php          NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- Optional bank/payout snapshot. May be filled at add-time here, or left
  -- blank and captured later in the Mark-Paid dialog (which snapshots onto the
  -- orphanage_dispatches row). These are convenience defaults only.
  bank_name           TEXT          NOT NULL DEFAULT '',
  bank_account_name   TEXT          NOT NULL DEFAULT '',
  bank_account_number TEXT          NOT NULL DEFAULT '',
  swift_code          TEXT          NOT NULL DEFAULT '',

  note                TEXT,

  created_by          TEXT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orphanage_worker_payments_created_idx
  ON public.orphanage_worker_payments (created_at DESC);

-- Updated-at trigger (reuse the same helper the dispatches table uses).
CREATE OR REPLACE FUNCTION public.set_orphanage_worker_payments_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_orphanage_worker_payments_updated_at ON public.orphanage_worker_payments;
CREATE TRIGGER trg_orphanage_worker_payments_updated_at
  BEFORE UPDATE ON public.orphanage_worker_payments
  FOR EACH ROW EXECUTE FUNCTION public.set_orphanage_worker_payments_updated_at();

-- ── Extend orphanage_dispatches to record worker payments ────────────────────
-- Add 'worker_payment' as a third dispatch_type and a source reference + a
-- self-contained name/type snapshot (so Reports can label the paid row without
-- joining back to the source).
ALTER TABLE public.orphanage_dispatches
  DROP CONSTRAINT IF EXISTS orphanage_dispatches_dispatch_type_check;
ALTER TABLE public.orphanage_dispatches
  ADD CONSTRAINT orphanage_dispatches_dispatch_type_check
  CHECK (dispatch_type IN ('budget_request', 'gift_shipping', 'worker_payment'));

ALTER TABLE public.orphanage_dispatches
  ADD COLUMN IF NOT EXISTS worker_payment_id UUID
    REFERENCES public.orphanage_worker_payments(id) ON DELETE SET NULL;
ALTER TABLE public.orphanage_dispatches
  ADD COLUMN IF NOT EXISTS recipient_name TEXT;
ALTER TABLE public.orphanage_dispatches
  ADD COLUMN IF NOT EXISTS worker_type TEXT;

-- One dispatch per worker payment (prevents double-logging), matching the
-- budget_request / gift_shipping partial-unique indexes.
CREATE UNIQUE INDEX IF NOT EXISTS orphanage_dispatches_worker_payment_uniq
  ON public.orphanage_dispatches (worker_payment_id)
  WHERE worker_payment_id IS NOT NULL;

-- Expose to Realtime (best-effort) so a future live subscription can pick up
-- changes. NOTE: the Orphanage tab currently loads via fetch + manual Refresh
-- (no postgres_changes subscription yet), so this only makes live updates
-- POSSIBLE later — it does not itself make the queue update live.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.orphanage_worker_payments;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END$$;

COMMIT;

-- Verification:
-- select recipient_name, worker_type, amount_php from public.orphanage_worker_payments order by created_at desc;
