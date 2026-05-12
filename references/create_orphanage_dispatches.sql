-- Migration: orphanage_dispatches
-- Tracks payments Lenny sends for approved orphanage budget requests
-- and approved employee gift shippings.
-- Run once in Supabase SQL editor.

CREATE TABLE IF NOT EXISTS public.orphanage_dispatches (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_type       TEXT          NOT NULL CHECK (dispatch_type IN ('budget_request', 'gift_shipping')),

  -- Source reference (exactly one will be non-null)
  budget_request_id   UUID          REFERENCES public.orphanage_budget_requests(id) ON DELETE SET NULL,
  gift_shipping_id    UUID          REFERENCES public.employee_gift_shipping_details(id) ON DELETE SET NULL,

  -- Human-readable label shown in the dispatch list and reports
  label               TEXT          NOT NULL,
  submitter_email     TEXT          NOT NULL,

  -- Bank snapshot (captured at dispatch creation so the record is self-contained)
  bank_name           TEXT          NOT NULL DEFAULT '',
  bank_account_name   TEXT          NOT NULL DEFAULT '',
  bank_account_number TEXT          NOT NULL DEFAULT '',
  swift_code          TEXT          NOT NULL DEFAULT '',

  -- Amount in PHP
  amount_php          NUMERIC(12,2) NOT NULL,

  -- Payment outcome — 'pending' until Lenny logs the transfer
  status              TEXT          NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending', 'paid', 'problem')),
  transaction_id      TEXT,
  bank_used           TEXT,   -- which of Lenny's sending banks
  sent_date           DATE,
  note                TEXT,

  -- Audit
  created_by          TEXT,
  paid_by             TEXT,
  paid_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- One dispatch per source item (prevents double-logging)
CREATE UNIQUE INDEX IF NOT EXISTS orphanage_dispatches_budget_request_uniq
  ON public.orphanage_dispatches (budget_request_id)
  WHERE budget_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS orphanage_dispatches_gift_shipping_uniq
  ON public.orphanage_dispatches (gift_shipping_id)
  WHERE gift_shipping_id IS NOT NULL;

-- Updated-at trigger
CREATE OR REPLACE FUNCTION public.set_orphanage_dispatches_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_orphanage_dispatches_updated_at ON public.orphanage_dispatches;
CREATE TRIGGER trg_orphanage_dispatches_updated_at
  BEFORE UPDATE ON public.orphanage_dispatches
  FOR EACH ROW EXECUTE FUNCTION public.set_orphanage_dispatches_updated_at();
