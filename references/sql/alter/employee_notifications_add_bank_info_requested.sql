-- Widen employee_notifications.type CHECK to allow the People-tab "Notify"
-- action's alert type: `bank_info.requested`.
--
-- The People tab's "Missing bank info" modal Notify button (see
-- app/api/people/request-bank-info/route.ts) inserts a `bank_info.requested`
-- notification for the employee. The table's CHECK constraint must list it or
-- the INSERT is rejected — and the Notify request would fail. ADD CONSTRAINT
-- re-validates existing rows, so we restate the FULL set the app inserts.
--
-- Run in the Supabase SQL editor after create_employee_notifications.sql and
-- 2026-06-29_bank_update_external_link.sql. Idempotent (DROP … IF EXISTS).

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
    'payroll.processing_started',
    'payroll.processing_stopped',
    'special_transfer.recorded',
    'qc.scores_submitted',
    'qc.scores_returned',
    'people.banking.self_updated',
    'bank_info.requested'
  ));

-- Verify:
-- select conname, pg_get_constraintdef(oid)
--   from pg_constraint where conname = 'employee_notifications_type_check';
