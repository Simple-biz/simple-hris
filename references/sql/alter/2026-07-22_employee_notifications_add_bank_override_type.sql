-- Widen employee_notifications.type CHECK to allow the Mark Paid bank-override
-- notification type: `people.banking.overridden`.
--
-- When Accounting overrides an employee's bank details from the Payment
-- Dispatch Mark Paid modal (app/api/payment-dispatch/bank-override/route.ts),
-- the employee gets a `people.banking.overridden` notification. The table's
-- CHECK must list it or the INSERT is silently rejected by the route's
-- best-effort try/catch.
--
-- ADD CONSTRAINT re-validates existing rows, so we restate the FULL
-- authoritative allowed set — the list from
-- 2026-07-22_employee_notifications_add_bank_preferred_type.sql (the latest
-- full list) PLUS the new people.banking.overridden. Restating a SUBSET would
-- silently break every other notification type's INSERT, so the whole list is
-- kept here verbatim. Run once in the Supabase SQL editor. Idempotent.

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
    'bank_preferred.decided'
  ));

-- Verify:
-- select conname, pg_get_constraintdef(oid)
--   from pg_constraint where conname = 'employee_notifications_type_check';
