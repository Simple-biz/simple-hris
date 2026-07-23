-- Urgent (one-off) payment requests — People-tab "Pay" action.
--
-- When CEO or Accounting clicks "Pay" on a person in the People tab and enters
-- an amount, a pending row is created here. It surfaces in Payment Dispatch →
-- Urgent (the "One-off Payments" section), where a payroll clerk enters the
-- transaction id / bank / date and clicks Send — which creates the
-- payment_dispatches record (cycle_id='urgent') and stamps this row 'dispatched'.
--
-- Deliberately SEPARATE from mesa_requests: the Urgent MESA feed is MESA-specific
-- (renders reason/explanation, reports as "MESA Disbursements"). Reusing it would
-- mislabel these one-off payments. This mirrors the mesa_requests approval shape
-- (see add_mesa_requests.sql) but for a self-approved, ad-hoc payout.
--
-- Run in the Supabase SQL editor (Dashboard → SQL Editor). Idempotent.

CREATE TABLE IF NOT EXISTS public.urgent_payment_requests (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  work_email    text          NOT NULL,          -- recipient (canonical id, lowercased)
  full_name     text          NOT NULL,
  department    text,
  -- The entered amount, in PHP.
  amount_php    numeric(12, 2) NOT NULL CHECK (amount_php > 0),
  -- Optional free-text reason the requester attached in the Pay dialog.
  note          text,
  status        text          NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'dispatched', 'cancelled')),
  -- Requester (CEO / Accounting actor email).
  requested_by  text,
  requested_at  timestamptz   NOT NULL DEFAULT now(),
  -- Stamped when the clerk sends it from the Urgent queue.
  dispatched_at timestamptz,
  -- The payment_dispatches.id created on Send (audit link back to the money log).
  dispatch_id   uuid,
  created_at    timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS urgent_payment_requests_status_idx
  ON public.urgent_payment_requests (status);
CREATE INDEX IF NOT EXISTS urgent_payment_requests_work_email_idx
  ON public.urgent_payment_requests (lower(work_email));
CREATE INDEX IF NOT EXISTS urgent_payment_requests_requested_at_idx
  ON public.urgent_payment_requests (requested_at DESC);

COMMENT ON TABLE public.urgent_payment_requests IS
  'One-off payments filed from the People tab "Pay" action (CEO/Accounting). Pending rows appear in Payment Dispatch → Urgent → One-off Payments; on Send a payment_dispatches (cycle_id=urgent) row is created and the row is stamped dispatched. Separate from mesa_requests by design.';
