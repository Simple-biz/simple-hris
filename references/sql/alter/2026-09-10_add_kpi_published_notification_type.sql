-- Widen employee_notifications.type CHECK to allow `kpi.published`: a department
-- manager marked a dept-week's KPI bonuses Ready or Locked in the Manager KPI
-- Calculator, so Accounting can see the week is scored and ready to be paid.
--
-- Kane, 2026-09-10 (Q1 of the score-ahead brief): managers may lock and submit
-- the UPCOMING pay week before its Hubstaff file exists, and "Accounting should
-- be able to be notified when a bonus is added". Fired once per
-- (recipient, department, period_start, status) from POST /api/hsl-bonus/period-status
-- — beside the existing employee-facing `kpi.scored` — to active `accounting`
-- role holders ONLY, the same recipient rule as `payroll.hours_gap`. Not per
-- keystroke: applied-row autosaves are deliberately unaudited on volume grounds
-- and would fire hundreds of times a week. See docs/features/hsl-kpi-calculator-2026-07.md
-- § Scoring the upcoming week.
--
-- ADD CONSTRAINT re-validates existing rows, so we restate the FULL authoritative
-- allowed set — the list from 2026-08-21_add_payroll_hours_gap_notification_type.sql
-- (the latest full list) PLUS kpi.published. Restating a SUBSET would silently
-- break every other notification type's INSERT, so the whole list is kept here
-- verbatim — and the paired apply script refuses to run if the LIVE constraint
-- carries a type this list lacks.
--
-- UNTIL THIS RUNS THE NOTIFICATION IS DEAD: every kpi.published insert is
-- rejected by this constraint. `kpi.scored` shipped exactly that way for three
-- days (2026-08-17 to 2026-08-20, 0 rows written) because the call site only
-- console.warn'd the failure. The notifier added alongside this file routes its
-- failures through notify-failure-audit instead, so a missed DDL is VISIBLE in
-- audit_log rather than silent — but the notification still does not exist
-- until this runs.
--
-- Run once (via scripts/apply-kpi-published-notification-type.mjs). Idempotent.

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
    'ticket.moved',
    'kpi.published'
  ));

-- VERIFY — the new type must appear in the live definition:
--   select pg_get_constraintdef(oid)
--     from pg_constraint where conname = 'employee_notifications_type_check';
