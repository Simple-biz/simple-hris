-- Widen employee_notifications.type CHECK to support the "salary paid" alert that
-- fires to the employee when Payment Dispatch marks their pay as paid. The card
-- carries an "Open Pay Stub" button (details.source_file) that opens the same
-- paystub the email dispatch sends.
--
-- ADD CONSTRAINT re-validates existing rows, so we restate the FULL allowed set —
-- the authoritative list from 2026-07-09_transfers_v2.sql PLUS the ticket types
-- (added in code) PLUS the new payroll.paid. Run in the Supabase SQL editor.

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
    'resignation.rejected',
    'ticket.replied',
    'ticket.assigned'
  ));
