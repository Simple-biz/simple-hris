-- Widen employee_notifications.type CHECK to allow the PAB exclusion
-- notification types: `pab.excluded` (Accounting excluded this person from a
-- month's Perfect Attendance Bonus) and `pab.restored` (the exclusion was
-- reversed). Fired from app/api/pab-exclusions/route.ts.
--
-- ADD CONSTRAINT re-validates existing rows, so we restate the FULL
-- authoritative allowed set — the list from
-- 2026-07-22_employee_notifications_add_bank_override_type.sql (the latest
-- full list) PLUS pab.excluded and pab.restored. Restating a SUBSET would
-- silently break every other notification type's INSERT, so the whole list
-- is kept here verbatim. Run once (via the paired apply script). Idempotent.

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
    'payroll.paid',
    'payroll.available',
    'special_transfer.recorded',
    'qc.scores_submitted',
    'qc.scores_returned',
    'people.banking.self_updated',
    'people.banking.overridden',
    'bank_info.requested',
    'offboarding.requested',
    'offboarding.request_completed',
    'offboarding.request_dismissed',
    'offboarding.request_returned',
    'resignation.submitted',
    'resignation.approved',
    'resignation.rejected',
    'ticket.replied',
    'ticket.assigned',
    'documents.requested',
    'documents.signed',
    'documents.rejected',
    'bank_preferred.decided',
    'pab.excluded',
    'pab.restored'
  ));

-- Verify:
-- select conname, pg_get_constraintdef(oid)
--   from pg_constraint where conname = 'employee_notifications_type_check';
