-- Widen employee_notifications.type CHECK to support dispute decision notifications.
-- Run in Supabase SQL editor after create_employee_notifications.sql.

ALTER TABLE public.employee_notifications
  DROP CONSTRAINT IF EXISTS employee_notifications_type_check;

ALTER TABLE public.employee_notifications
  ADD CONSTRAINT employee_notifications_type_check
  CHECK (type IN ('rate.change', 'promotion', 'dispute.approved', 'dispute.denied', 'dispute.revoked'));
