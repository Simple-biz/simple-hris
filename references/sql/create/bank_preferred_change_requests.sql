-- Bank Preferred change requests — accounting approval gate.
--
-- When an employee changes their "Bank Preferred" (Profile → Payment), the new
-- value is held here as a pending request instead of being written straight to
-- employee_ids.bank_preferred. Accounting approves/denies in the Issues tab.
-- On approve, the value is written to employee_ids.bank_preferred and applied_at
-- is stamped. Until then, the employee's current approved value stays live for
-- Payment Dispatch.
--
-- Mirrors the mesa_requests approval workflow (see add_mesa_requests.sql).
-- Run in the Supabase SQL editor (Dashboard → SQL Editor). Idempotent.

CREATE TABLE IF NOT EXISTS public.bank_preferred_change_requests (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  work_email    text        NOT NULL,
  employee_name text,
  -- Current bank_preferred at request time (processor id, or NULL for a first-time set).
  from_value    text,
  -- Requested bank_preferred (processor id; x1153 maps to 'wires' before it gets here).
  to_value      text        NOT NULL
    CHECK (to_value IN ('hurupay', 'wepay', 'higlobe', 'wise', 'jeeves', 'wires')),
  status        text        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'superseded')),
  review_notes  text,
  reviewed_by   text,
  reviewed_at   timestamptz,
  -- Set when to_value is written into employee_ids.bank_preferred (on approve).
  applied_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bank_preferred_change_requests_work_email_idx
  ON public.bank_preferred_change_requests (work_email);
CREATE INDEX IF NOT EXISTS bank_preferred_change_requests_status_idx
  ON public.bank_preferred_change_requests (status);
CREATE INDEX IF NOT EXISTS bank_preferred_change_requests_created_at_idx
  ON public.bank_preferred_change_requests (created_at DESC);

-- At most ONE pending request per employee. Submitting a new change supersedes
-- the previous pending one (the app flips the old row to 'superseded' first),
-- so this partial unique index is the backstop that enforces the invariant.
CREATE UNIQUE INDEX IF NOT EXISTS bank_preferred_change_requests_one_pending_idx
  ON public.bank_preferred_change_requests (work_email)
  WHERE status = 'pending';

COMMENT ON TABLE public.bank_preferred_change_requests IS
  'Pending employee Bank Preferred changes awaiting Accounting approval. On approve the to_value is written to employee_ids.bank_preferred. Mirrors mesa_requests.';
