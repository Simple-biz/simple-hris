-- Adds manager approval columns to time_adjustment_requests.
-- Run after time_adjustment_requests.sql.
-- Status lifecycle: pending -> manager_approved | manager_denied -> approved | denied
-- No CHECK constraint on status so new values just work.

alter table public.time_adjustment_requests
  add column if not exists manager_decided_by   text,
  add column if not exists manager_decided_at   timestamptz,
  add column if not exists manager_decision_note text;
