-- Migration: payroll_rate_exemptions
-- Created: 2026-09-01
--
-- "Ignore" on the Payroll Wizard → Readiness → No Pay Rate list — the rate
-- twin of payroll_bank_exemptions (2026-08-04), deliberately a SEPARATE table
-- so the bank one keeps its documented bank-only semantics untouched.
--
-- Accounting can acknowledge a person's missing pay rate FOR ONE PAY WEEK:
-- the person leaves the No Pay Rate list (and the readiness score's rate
-- dimension, list and worker denominator alike) and instead shows up under
-- Exceptions, exactly like an onboarding hire or a no-show — an expected
-- non-payment rather than an open task.
--
-- The ignore is week-scoped BY DESIGN and never expires on a timer: a row is
-- only honoured for the `week_start` it was filed against, so the person
-- automatically reappears on next week's No Pay Rate list if they log hours
-- and still have no rate. No cron / expiry job is involved.
--
-- Readiness-only by design: this table is read by
-- src/lib/payroll/payroll-readiness.ts and NOTHING else. It does not touch the
-- wizard's pay computation or Payment Dispatch — a person with no resolvable
-- rate still can't be priced; the ignore only silences the readiness nag for
-- the week.
--
-- Revocation is a SOFT delete (`revoked_at`), mirroring `employee_roles`, so an
-- Undo keeps the history of who ignored whom and who reversed it.
--
-- Access is enforced at the API layer (app/api/payroll-wizard/rate-exemptions)
-- via the accounting/payroll_wizard feature grant — no RLS, same as the other
-- wizard tables.
--
-- Apply with scripts/apply-rate-exemptions-migration.mjs (needs DATABASE_URL,
-- session pooler). Idempotent. Deliberately NO BEGIN/COMMIT of its own: the
-- apply script owns the transaction (its --dry rehearsal wraps this file in a
-- BEGIN it always rolls back, and an inner COMMIT would break out of it), and
-- a single multi-statement run in the SQL editor is atomic anyway.

CREATE TABLE IF NOT EXISTS public.payroll_rate_exemptions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Identity, stored as the readiness row carried it. Matching is done on the
  -- person's emails (lowercased) so an ignore filed against either alias still
  -- hides the person however the rate list keyed them; `name` is the display
  -- value and the last-resort match for a row with no email at all.
  work_email      text,
  personal_email  text,
  name            text        NOT NULL,
  department      text,
  -- The readiness week the ignore applies to: the pay week that was IN VIEW
  -- when Accounting clicked Ignore (the Hubstaff filename's date-range start —
  -- see weekKeyFromSourceFile in payroll-readiness.ts).
  week_start      date        NOT NULL,
  -- Optional one-liner from the confirm dialog ("contractor conversion pending").
  reason          text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Soft delete for Undo. NULL = active.
  revoked_at      timestamptz,
  revoked_by      text,
  -- At least one identity key, or the row can never be matched to a person.
  CONSTRAINT payroll_rate_exemptions_identity_present
    CHECK (COALESCE(work_email, personal_email, '') <> '' OR name <> '')
);

-- The hot read: every ACTIVE ignore for one week.
CREATE INDEX IF NOT EXISTS payroll_rate_exemptions_week_active_idx
  ON public.payroll_rate_exemptions (week_start)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS payroll_rate_exemptions_work_email_idx
  ON public.payroll_rate_exemptions (lower(work_email));

-- One ACTIVE ignore per person per week — a double-click (or two clerks on the
-- same row) can't stack duplicate rows that would then each need their own
-- Undo. Partial-unique on the revoked_at IS NULL slice so a revoked row never
-- blocks re-ignoring the same person in the same week.
CREATE UNIQUE INDEX IF NOT EXISTS payroll_rate_exemptions_one_active_per_person_week
  ON public.payroll_rate_exemptions (
    week_start,
    lower(COALESCE(work_email, '')),
    lower(COALESCE(personal_email, '')),
    lower(name)
  )
  WHERE revoked_at IS NULL;

COMMENT ON TABLE public.payroll_rate_exemptions IS
  'Per-week "Ignore" records from Payroll Wizard → Readiness → No Pay Rate. An active row (revoked_at IS NULL) for the week in view moves the person off the No Pay Rate list and the readiness score''s rate dimension, and onto the Exceptions list. Week-scoped: they reappear next week automatically. Readiness-only — does NOT touch the wizard''s pay computation or Payment Dispatch.';

-- Realtime: readiness already live-refreshes on the tables it reads, so an
-- ignore filed by one clerk lands on every open Readiness pane.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='payroll_rate_exemptions'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.payroll_rate_exemptions;
    END IF;
  END IF;
END $$;
