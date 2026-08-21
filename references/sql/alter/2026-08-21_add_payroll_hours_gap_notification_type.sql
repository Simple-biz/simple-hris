-- Widen employee_notifications.type CHECK to allow `payroll.hours_gap`: a
-- Hubstaff week was just ingested and N ACTIVE roster members logged no hours
-- with nothing in the HRIS explaining it (not an untracked department, not an
-- approved leave, not a new hire). Fired once per (recipient, source_file) from
-- both ingest paths — POST /api/hubstaff-hours and runHubstaffWeeklySync — to
-- active `accounting` role holders ONLY (Kane, 2026-08-21, Q4).
--
-- It is a reconciliation REMINDER, not a payroll gate: "still active, or on
-- leave, or sick — or did someone forget to offboard them?" The case that
-- prompted it is jvincec@simple.biz, Active with zero hours from 2026-08-05 and
-- found only because someone happened to ask. See
-- docs/features/hubstaff-zero-hours-gap.md.
--
-- ADD CONSTRAINT re-validates existing rows, so we restate the FULL
-- authoritative allowed set — the list from
-- 2026-08-21_add_ticket_moved_notification_type.sql (the latest full list) PLUS
-- payroll.hours_gap. Restating a SUBSET would silently break every other
-- notification type's INSERT, so the whole list is kept here verbatim — and the
-- paired apply script refuses to run if the LIVE constraint carries a type this
-- list lacks.
--
-- UNTIL THIS RUNS THE FEATURE IS DEAD, AND SILENTLY SO: every payroll.hours_gap
-- insert is rejected by this constraint. `kpi.scored` shipped exactly that way
-- for three days (2026-08-17 to 2026-08-20, 0 rows written against 3,694 for
-- payroll.available) because the call site only console.warn'd the failure. The
-- notifier added alongside this file routes its failures through
-- notify-failure-audit instead, so a missed DDL is visible rather than silent —
-- but the notification still does not exist until this runs.
--
-- Run once (via scripts/apply-hours-gap-notification-type.mjs). Idempotent.

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
    'payroll.hours_gap',
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
