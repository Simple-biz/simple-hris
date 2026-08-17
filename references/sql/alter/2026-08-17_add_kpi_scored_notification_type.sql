-- Widen employee_notifications.type CHECK to allow `kpi.scored`: the manager
-- published (or changed) this employee's KPI bonus for a dept-week — fired from
-- app/api/hsl-bonus/period-status (Mark Ready / Lock) and from the bonus write
-- routes when a change lands on an already-published week. See
-- docs/features/kpi-scored-notification.md.
--
-- ADD CONSTRAINT re-validates existing rows, so we restate the FULL
-- authoritative allowed set — the list from
-- 2026-08-03_pab_exclusion_notification_types.sql (the latest full list) PLUS
-- kpi.scored. Restating a SUBSET would silently break every other notification
-- type's INSERT, so the whole list is kept here verbatim — and the paired apply
-- script refuses to run if the LIVE constraint carries a type this list lacks.
-- Run once (via scripts/apply-kpi-scored-notification-type.mjs). Idempotent.

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
    'pab.restored',
    'kpi.scored'
  ));

-- Verify:
-- select conname, pg_get_constraintdef(oid)
--   from pg_constraint where conname = 'employee_notifications_type_check';
