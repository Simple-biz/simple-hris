-- Expand employee_notifications.type CHECK to include onboarding,
-- time-adjustment, transfer, and payroll types used by the notification system.
-- Run in Supabase SQL editor.

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
    'payroll.processing_stopped'
  ));
