-- ============================================================================
-- Offboarding Queue — manager-raised offboarding requests, actioned by HR
--   (2026-07-02, migration #98)
-- ============================================================================
--
-- A manager multi-selects people in Manager → My Team and sends them to HR for
-- offboarding. Each selected person becomes one `offboarding_queue` row (status
-- 'pending'). HR sees the queue in the HR → Offboarding tab's new "Queue"
-- sub-tab and processes them ONE BY ONE (the account-teardown automation does
-- not handle bulk yet): each row's Process step calls the existing single
-- POST /api/hr/offboard, then flips the row to 'completed'. HR can also
-- 'dismiss' a row (with a reason). The requesting manager is notified on
-- completion/dismissal and sees the live status back on their My Team list.
--
-- Lifecycle: pending → processing (HR is working the batch) → completed
--                     ↘ dismissed (HR rejected)
--                     ↘ cancelled (manager withdrew their own pending request)
--
-- Mirrors public.department_transfer_requests (same manager→HR request shape).
-- Idempotent — safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS public.offboarding_queue (
  id                      uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  -- best identifying email (personal preferred) — used for the pending-dupe guard
  employee_email          text         NOT NULL,
  employee_name           text,
  employee_work_email     text,
  employee_personal_email text,
  department              text,
  -- the manager's stated offboard reason (one of the offboard reason keys) + note
  reason                  text         NOT NULL,
  note                    text,
  status                  text         NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','processing','completed','dismissed','cancelled')),
  requested_by            text         NOT NULL,   -- manager email
  requested_by_name       text,
  -- HR side, stamped when the row is completed/dismissed
  processed_by            text,                    -- HR email
  processed_note          text,                    -- HR note, or the dismiss reason
  offboard_reason         text,                    -- the reason HR actually used at offboard time
  decided_at              timestamptz,
  created_at              timestamptz  NOT NULL DEFAULT now(),
  updated_at              timestamptz  NOT NULL DEFAULT now()
);

-- HR's queue reads pending-first, newest-first.
CREATE INDEX IF NOT EXISTS offboarding_queue_status_idx
  ON public.offboarding_queue (status, created_at DESC);

-- Manager's outbox (their own requests → drives the My Team status badges).
CREATE INDEX IF NOT EXISTS offboarding_queue_requested_by_idx
  ON public.offboarding_queue (lower(requested_by));

-- Pending-dupe guard looks up by employee email.
CREATE INDEX IF NOT EXISTS offboarding_queue_employee_email_idx
  ON public.offboarding_queue (lower(employee_email));

-- ---------------------------------------------------------------------------
-- Widen employee_notifications.type CHECK to allow the 3 offboarding-queue
-- notification types:
--   offboarding.requested          → to HR/admin when a manager submits
--   offboarding.request_completed  → to the manager when HR offboards the person
--   offboarding.request_dismissed  → to the manager when HR dismisses the request
--
-- ADD CONSTRAINT re-validates existing rows, so we restate the FULL allowed set
-- (this supersedes migration #96's widening — the whole list is repeated here).
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
    'offboarding.request_dismissed'
  ));

COMMIT;

-- Verify:
-- select conname, pg_get_constraintdef(oid)
--   from pg_constraint where conname = 'employee_notifications_type_check';
-- select count(*) from public.offboarding_queue;
