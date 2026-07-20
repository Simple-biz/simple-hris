-- Widen employee_notifications.type CHECK to support the "salary ready to view"
-- alert that fires to every employee in a payroll week when Accounting uploads a
-- new Hubstaff CSV (or runs the API sync) in the Payroll Wizard. The card carries
-- the SAME "Open Pay Stub" button (details.source_file) as payroll.paid — it opens
-- the reconstructed/staged statement for that week (see the SHOW_UNPAID_STAGED_PAYSTUBS
-- pre-launch gate in app/api/employee/paystub/route.ts).
--
-- ADD CONSTRAINT re-validates existing rows, so we restate the FULL allowed set —
-- the authoritative list from 2026-07-18_documents_tab.sql PLUS the new
-- payroll.available. Run once in the Supabase SQL editor. Idempotent.
--
-- Until this runs, the payroll.available INSERT is silently rejected by the notify
-- helper's try/catch (same footgun as add_payroll_paid_notification_type.sql).

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
    'documents.rejected'
  ));
