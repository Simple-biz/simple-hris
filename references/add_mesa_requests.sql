-- MESA Requests table
-- Stores employee-submitted requests: opt-in, opt-out, disbursement, and return.
-- Accounting reviews pending rows and marks them approved or denied.

CREATE TABLE IF NOT EXISTS mesa_requests (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  work_email          text        NOT NULL,
  full_name           text        NOT NULL,
  department          text        NOT NULL,
  request_type        text        NOT NULL
    CHECK (request_type IN ('opt_in', 'opt_out', 'disbursement', 'return')),
  -- Opt-in only: date the employee completed FPU (free-text from the form, stored as-is)
  fpu_date            text,
  -- Disbursement only: reason category
  disbursement_reason text,
  -- Disbursement: employee-written explanation (max 250 chars enforced by the UI)
  explanation         text,
  -- Disbursement: amount requested in PHP
  amount_needed       numeric(12, 2),
  status              text        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied')),
  review_notes        text,
  reviewed_by         text,
  reviewed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mesa_requests_work_email_idx  ON mesa_requests (work_email);
CREATE INDEX IF NOT EXISTS mesa_requests_status_idx      ON mesa_requests (status);
CREATE INDEX IF NOT EXISTS mesa_requests_created_at_idx  ON mesa_requests (created_at DESC);
