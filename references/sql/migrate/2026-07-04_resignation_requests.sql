-- ============================================================================
-- Resignation Requests — employee-initiated resignation, approved by their
--   department manager, then auto-fed into the offboarding queue (2026-07-04, #99)
-- ============================================================================
--
-- An employee opens Profile → Resign, picks an effective date, writes a short
-- message, and taps the big red "Resign" button. That creates one
-- `resignation_requests` row (status 'pending') and notifies the department's
-- manager(s). The resigning person floats to the TOP of the manager's My Team
-- roster (Cards + List) with their message shown inline. When a manager
-- Approves, the app inserts an `offboarding_queue` row (reason = 'resigned',
-- requested_by = the approving manager) so the person lands in HR's existing
-- offboarding queue, and stamps the queue id back on the resignation row. HR
-- then processes the offboarding exactly as it does today.
--
-- Lifecycle: pending → approved (queued for offboarding)
--                    ↘ rejected  (manager declined; note = reason)
--                    ↘ cancelled (employee withdrew their own pending request)
--
-- Mirrors public.leave_requests (same employee→manager approval shape); the
-- approval side reuses the offboarding_queue machinery unchanged.
-- Idempotent — safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS public.resignation_requests (
  id                      uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  -- best identifying email (personal preferred) — carried into offboarding_queue
  employee_email          text         NOT NULL,
  employee_name           text,
  employee_work_email     text,
  employee_personal_email text,
  department              text,
  -- the employee-chosen effective date (their last working day)
  effective_date          date         NOT NULL,
  -- the employee's own resignation message (shown to the manager on the roster)
  message                 text,
  status                  text         NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','approved','rejected','cancelled')),
  -- comma-joined department-manager emails resolved + stamped at submit time
  manager_email           text,
  -- manager decision side
  approver_email          text,
  approver_note           text,
  decided_at              timestamptz,
  -- set on approval: the offboarding_queue row this resignation created
  offboarding_queue_id    uuid,
  created_at              timestamptz  NOT NULL DEFAULT now(),
  updated_at              timestamptz  NOT NULL DEFAULT now()
);

-- The manager's roster reads pending-first, newest-first.
CREATE INDEX IF NOT EXISTS resignation_requests_status_idx
  ON public.resignation_requests (status, created_at DESC);

-- Employee's own history + the one-active-pending guard look up by email.
CREATE INDEX IF NOT EXISTS resignation_requests_employee_email_idx
  ON public.resignation_requests (lower(employee_email));

-- Roster match falls back to the two explicit email columns.
CREATE INDEX IF NOT EXISTS resignation_requests_work_email_idx
  ON public.resignation_requests (lower(employee_work_email));

-- Converge the status CHECK for an already-created table (the inline CHECK only
-- applies on first CREATE).
ALTER TABLE public.resignation_requests
  DROP CONSTRAINT IF EXISTS resignation_requests_status_check;
ALTER TABLE public.resignation_requests
  ADD CONSTRAINT resignation_requests_status_check
  CHECK (status IN ('pending','approved','rejected','cancelled'));

-- ---------------------------------------------------------------------------
-- Widen employee_notifications.type CHECK to allow the 3 resignation types:
--   resignation.submitted → to the department manager(s) when an employee resigns
--   resignation.approved  → to the employee when a manager approves (→ offboarding)
--   resignation.rejected  → to the employee when a manager declines
--
-- ADD CONSTRAINT re-validates existing rows, so we restate the FULL allowed set
-- (this supersedes migration #98's widening — the whole list is repeated here).
-- ---------------------------------------------------------------------------
ALTER TABLE public.employee_notifications
  DROP CONSTRAINT IF EXISTS employee_notifications_type_check;
ALTER TABLE public.employee_notifications
  ADD CONSTRAINT employee_notifications_type_check
  CHECK (type IN (
    'rate.change',
    'promotion',
    'dispute.approved',
    'dispute.denied',
    'dispute.revoked',
    'onboarding.submitted',
    'time_adjustment.approved',
    'time_adjustment.denied',
    'transfer.requested',
    'transfer.approved',
    'transfer.rejected',
    'payroll.processing_started',
    'payroll.processing_stopped',
    'special_transfer.recorded',
    'qc.scores_submitted',
    'qc.scores_returned',
    'people.banking.self_updated',
    'bank_info.requested',
    'offboarding.requested',
    'offboarding.request_completed',
    'offboarding.request_dismissed',
    'offboarding.request_returned',
    'resignation.submitted',
    'resignation.approved',
    'resignation.rejected'
  ));

-- Keep the resignation feed live (roster float-to-top + employee status update).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'resignation_requests'
     )
  THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.resignation_requests';
  END IF;
END $$;

COMMIT;

-- Verify:
-- select conname, pg_get_constraintdef(oid)
--   from pg_constraint where conname = 'employee_notifications_type_check';
-- select count(*) from public.resignation_requests;
