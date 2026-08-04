-- Migration: payroll_bank_exemptions
-- Created: 2026-08-04
--
-- "Temporary Exemption" on the Payroll Wizard → Readiness → Bank Info list.
--
-- Accounting can acknowledge a person's missing payout details FOR ONE PAY WEEK:
-- the person leaves the Bank Info list (and the readiness score's bank
-- dimension) and instead shows up under Exceptions, exactly like an onboarding
-- hire or a no-show — an expected non-payment rather than an open task.
--
-- The exemption is week-scoped BY DESIGN and never expires on a timer: a row is
-- only honoured for the `week_start` it was filed against, so the person
-- automatically reappears on next week's Bank Info list if their details are
-- still missing. No cron / expiry job is involved.
--
-- Readiness-only by design: this table is read by
-- src/lib/payroll/payroll-readiness.ts and NOTHING else. It does not affect
-- Payment Dispatch — someone with no payout rail still can't be paid; the
-- exemption only silences the readiness nag for the week.
--
-- Revocation is a SOFT delete (`revoked_at`), mirroring `employee_roles`, so an
-- Undo keeps the history of who exempted whom and who reversed it.
--
-- Access is enforced at the API layer (app/api/payroll-wizard/bank-exemptions)
-- via the accounting/payroll_wizard feature grant — no RLS, same as the other
-- wizard tables.
--
-- Run in the Supabase SQL editor (Dashboard → SQL Editor). Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS public.payroll_bank_exemptions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Identity, stored as the readiness row carried it. Matching is done on BOTH
  -- emails (lowercased) so an exemption filed against either alias still hides
  -- the person however the bank list keyed them; `name` is the display value
  -- and the last-resort match for a row with no email at all.
  work_email      text,
  personal_email  text,
  name            text        NOT NULL,
  department      text,
  -- The readiness week the exemption applies to: the pay week that was IN VIEW
  -- when Accounting clicked Temporary Exemption (the Hubstaff filename's
  -- date-range start — see weekKeyFromSourceFile in payroll-readiness.ts).
  week_start      date        NOT NULL,
  -- Optional one-liner from the confirm dialog ("waiting on her Wise handle").
  reason          text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Soft delete for Undo. NULL = active.
  revoked_at      timestamptz,
  revoked_by      text,
  -- At least one identity key, or the row can never be matched to a person.
  CONSTRAINT payroll_bank_exemptions_identity_present
    CHECK (COALESCE(work_email, personal_email, '') <> '' OR name <> '')
);

-- The hot read: every ACTIVE exemption for one week.
CREATE INDEX IF NOT EXISTS payroll_bank_exemptions_week_active_idx
  ON public.payroll_bank_exemptions (week_start)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS payroll_bank_exemptions_work_email_idx
  ON public.payroll_bank_exemptions (lower(work_email));

-- One ACTIVE exemption per person per week — a double-click (or two clerks on
-- the same row) can't stack duplicate rows that would then need two Undos.
-- Partial-unique on the revoked_at IS NULL slice so a revoked row never blocks
-- re-exempting the same person in the same week.
CREATE UNIQUE INDEX IF NOT EXISTS payroll_bank_exemptions_one_active_per_person_week
  ON public.payroll_bank_exemptions (
    week_start,
    lower(COALESCE(work_email, '')),
    lower(COALESCE(personal_email, '')),
    lower(name)
  )
  WHERE revoked_at IS NULL;

COMMENT ON TABLE public.payroll_bank_exemptions IS
  'Per-week "Temporary Exemption" records from Payroll Wizard → Readiness → Bank Info. An active row (revoked_at IS NULL) for the week in view moves the person off the Bank Info list and the readiness score''s bank dimension, and onto the Exceptions list. Week-scoped: they reappear next week automatically. Readiness-only — does NOT affect Payment Dispatch.';

-- Realtime: readiness already live-refreshes on the tables it reads, so an
-- exemption filed by one clerk lands on every open Readiness pane.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='payroll_bank_exemptions'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.payroll_bank_exemptions;
    END IF;
  END IF;
END $$;

COMMIT;
