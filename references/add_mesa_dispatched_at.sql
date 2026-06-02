-- Adds dispatched_at to mesa_requests so accounting-approved disbursements
-- can be tracked once Lenny sends the money via Payment Dispatch.
-- Run once in Supabase SQL editor.

ALTER TABLE mesa_requests
  ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;

-- Index: fast look-up of undispatched approved disbursements for the
-- Urgent Payments queue in Payroll Clerk.
CREATE INDEX IF NOT EXISTS idx_mesa_requests_urgent_queue
  ON mesa_requests (status, request_type, dispatched_at)
  WHERE status = 'approved'
    AND request_type = 'disbursement';
