-- Migration: penny_employee_usage
-- Created: 2026-08-19
--
-- The prompt ledger behind Employee Penny AI's daily allowance (10 prompts per
-- Asia/Manila calendar day, Kane 2026-08-19). See docs/features/employee-penny-ai.md.
--
-- THE COUNT OF ROWS *IS* THE QUOTA. There is deliberately no counter column and
-- no per-employee settings row: a mutable counter has an increment race (two
-- browser tabs, one read-modify-write each, one lost update = a free prompt),
-- while counting rows cannot drift from what actually happened.
--
-- Deliberately NOT stored in `audit_log`, even though Penny also audit-logs
-- there: the audit log is truncatable by admins (see the Admin Penny tool notes
-- in src/lib/anthropic/admin-tools.ts), and a truncation would silently refund
-- the whole company's daily allowance. Penny still writes its
-- `employee_assistant.query` audit row — that is the trail, this is the meter.
--
-- Reserve-then-settle. A row is INSERTed before the Anthropic call, so a
-- double-send can't slip past the pre-check; if the turn produces no answer text
-- (route error, aborted stream, upstream 5xx) it is stamped `refunded_at` and
-- stops counting. Refunds are a soft delete, matching payroll_bank_exemptions'
-- `revoked_at` — the history of what was charged and reversed survives.
--
-- Two emails, on purpose (Q3(a), Kane 2026-08-19):
--   session_email = the signed-in human whose allowance is charged;
--   subject_email = whose data the answer was about.
-- They differ only when an ELEVATED viewer opens /employee?email=someone.else,
-- and elevated viewers are exempt from the cap — so those rows are recorded for
-- the trail but must never be counted against the employee they were viewing.
-- Any "how many has X used" query therefore keys on SESSION_EMAIL, never subject.
--
-- Access is enforced at the API layer (app/api/employee/penny-chat) — no RLS,
-- same as the payroll wizard's tables. Nothing outside src/lib/penny reads it.
--
-- Run in the Supabase SQL editor, or via
--   node scripts/apply-penny-employee-usage.mjs --apply
-- Idempotent: a re-run is a no-op.

BEGIN;

CREATE TABLE IF NOT EXISTS public.penny_employee_usage (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The signed-in account being charged. Lowercased by the writer; every read
  -- matches case-insensitively anyway.
  session_email  text        NOT NULL,
  -- Whose information the answer was about. Equal to session_email for a plain
  -- employee; differs only for an elevated ?email= viewer.
  subject_email  text        NOT NULL,
  -- True when the asker held an elevated role (admin/accounting/hr/ceo) and was
  -- therefore NOT capped. Kept so the ledger can be read honestly later: an
  -- exempt row is a record of a question, not of a consumed allowance.
  elevated       boolean     NOT NULL DEFAULT false,
  asked_at       timestamptz NOT NULL DEFAULT now(),
  -- The Asia/Manila calendar day the prompt was charged to, stored verbatim by
  -- the writer. The count query filters on asked_at (indexed); this column
  -- exists so a human reading the table can see which day a row belonged to
  -- without redoing the +08:00 arithmetic.
  manila_day     date        NOT NULL,
  -- Tool names that ran, for the same reason the CEO/Admin routes audit them.
  tools_used     text[]      NOT NULL DEFAULT '{}',
  -- Soft "this one didn't count". NULL = charged.
  refunded_at    timestamptz,
  refund_reason  text
);

-- The hot read: how many CHARGED prompts has this account used since Manila
-- midnight. Partial index on the charged slice so refunded rows never widen it.
CREATE INDEX IF NOT EXISTS penny_employee_usage_session_day_idx
  ON public.penny_employee_usage (lower(session_email), asked_at)
  WHERE refunded_at IS NULL;

-- Secondary: reading one person's whole Penny history (support questions).
CREATE INDEX IF NOT EXISTS penny_employee_usage_subject_idx
  ON public.penny_employee_usage (lower(subject_email), asked_at DESC);

COMMENT ON TABLE public.penny_employee_usage IS
  'Prompt ledger for Employee Penny AI. One row per prompt; the COUNT of non-refunded rows for (session_email, Manila day) IS the daily allowance meter (limit 10). Reserved before the model call and stamped refunded_at when a turn produced no answer. session_email = who is charged, subject_email = whose data was answered about (they differ only for an elevated ?email= viewer, who is exempt from the cap). Never count by subject_email.';

COMMENT ON COLUMN public.penny_employee_usage.elevated IS
  'The asker held an elevated role and was NOT capped — the row records a question, not a consumed allowance.';

COMMENT ON COLUMN public.penny_employee_usage.refunded_at IS
  'Soft delete: the turn produced no answer text, so it does not count against the daily allowance.';

COMMIT;
