-- Widen employee_notifications.type CHECK to allow `ticket.moved`: a ticket on
-- the /tickets HRIS-updates board changed column, and the person who FILED it is
-- told where it went. Fired from PATCH /api/tickets/[id] on any status
-- transition, including a backward Testing -> In Progress bounce. `done` keeps
-- its own path (notifyTicketDone), so in practice this type carries To Do /
-- In Progress / Testing. See docs/features/tickets-board.md.
--
-- ADD CONSTRAINT re-validates existing rows, so we restate the FULL
-- authoritative allowed set — the list from
-- 2026-08-17_add_kpi_scored_notification_type.sql (the latest full list) PLUS
-- ticket.moved. Restating a SUBSET would silently break every other notification
-- type's INSERT, so the whole list is kept here verbatim — and the paired apply
-- script refuses to run if the LIVE constraint carries a type this list lacks.
--
-- UNTIL THIS RUNS THE FEATURE IS DEAD, AND SILENTLY SO: every ticket.moved
-- insert is rejected by this constraint and the call site reports it through
-- console.warn only. That is precisely how `kpi.scored` shipped dead for three
-- days (2026-08-17 to 2026-08-20, 0 rows written against 3,694 for
-- payroll.available). Run it, then confirm it ran.
--
-- Run once (via scripts/apply-ticket-moved-notification-type.mjs). Idempotent.

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
    'kpi.scored',
    'ticket.moved'
  ));

-- VERIFY — the new type must appear in the live definition:
--   select pg_get_constraintdef(oid)
--     from pg_constraint where conname = 'employee_notifications_type_check';
