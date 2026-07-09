-- ============================================================================
-- Department Transfers v2 — manager-driven pull-in + effective date + Sheet
--   write-back state + new transfer.* notification types (2026-07-09)
-- ============================================================================
--
-- The transfer flow was reworked (see docs / plan "Department Transfers v2"):
--   • A RECEIVING manager requests a person from another department and proposes
--     an effective date; the person's CURRENT (source) manager says yes/no.
--   • On "release" the effective date is LOCKED. The department change is applied
--     to global_master_list AND written back to the master Google Sheet, either
--     immediately (effective date already due) or by the daily
--     apply-scheduled-transfers cron once the effective date arrives.
--   • HR no longer approves — HR + Accounting only VIEW the history.
--
-- This migration:
--   1. Adds the v2 columns to department_transfer_requests.
--   2. Widens its status CHECK with 'applied'.
--   3. Widens employee_notifications.type CHECK with the 4 new transfer.* types
--      (restating the FULL allowed set — supersedes #98/#99).
--   4. Exposes department_transfer_requests to Realtime so the source manager's
--      consent queue floats in live.
--
-- Idempotent — safe to re-run.

BEGIN;

-- ── 1. New columns on department_transfer_requests ──────────────────────────
ALTER TABLE public.department_transfer_requests
  ADD COLUMN IF NOT EXISTS proposed_effective_date date,
  ADD COLUMN IF NOT EXISTS effective_date          date,
  ADD COLUMN IF NOT EXISTS applied_at              timestamptz,
  ADD COLUMN IF NOT EXISTS sheet_synced            boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sheet_sync_error        text;

-- ── 2. Widen the status CHECK to add 'applied' ──────────────────────────────
--   pending   → awaiting the source manager's release decision
--   approved  → released; effective date locked; scheduled for the effective date
--   applied   → department written to master + Sheet
--   rejected  → source manager declined (approver_note = reason)
--   cancelled → receiving manager withdrew their own pending request
ALTER TABLE public.department_transfer_requests
  DROP CONSTRAINT IF EXISTS department_transfer_requests_status_check;
ALTER TABLE public.department_transfer_requests
  ADD CONSTRAINT department_transfer_requests_status_check
  CHECK (status IN ('pending','approved','applied','rejected','cancelled'));

-- The cron scans approved rows whose effective date is due.
CREATE INDEX IF NOT EXISTS department_transfer_requests_scheduled_idx
  ON public.department_transfer_requests (status, effective_date);

-- ── 3. Widen employee_notifications.type CHECK ──────────────────────────────
--   transfer.release_requested → source dept manager(s): someone wants to pull a report
--   transfer.released          → receiving manager: source manager released the person
--   transfer.declined          → receiving manager: source manager declined
--   transfer.applied           → receiving manager + the employee: the move took effect
--
-- ADD CONSTRAINT re-validates existing rows, so we restate the FULL allowed set.
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
    'transfer.release_requested',
    'transfer.released',
    'transfer.declined',
    'transfer.applied',
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

-- ── 4. Keep the transfer feed live (source-manager consent float-to-top) ────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'department_transfer_requests'
     )
  THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.department_transfer_requests';
  END IF;
END $$;

COMMIT;

-- Verify:
-- select conname, pg_get_constraintdef(oid)
--   from pg_constraint where conname = 'department_transfer_requests_status_check';
-- select conname, pg_get_constraintdef(oid)
--   from pg_constraint where conname = 'employee_notifications_type_check';
