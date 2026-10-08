-- ============================================================================
-- [PAYOUT-ACCOUNT-REPORTS] payout_account_reports  (2026-10-08)
--
-- Kane, 2026-10-08: "a mechanism for the Employees to mark these Bank Accounts as
-- closed, deactivated or frozen some stuff like that so Accounting would know".
--
-- One row per report an employee files about ONE of their own payout accounts
-- (the paid bank slot, the backup slot, or the paid wallet), from Profile ->
-- Payout or the public /update-bank-info link. It INFORMS Accounting (alert,
-- People -> Banking, Mark Paid). It never changes routing and never touches
-- employee_ids. docs/features/payout-account-reports.md.
--
-- The account is identified WITHOUT storing it:
--   account_fingerprint = HMAC-SHA256(NEXTAUTH_SECRET, "<account|wallet>:<digits or lowercased email>")
--   account_hint        = the masked form the trail already uses (last 4 / first char + domain)
-- So a report follows the ACCOUNT, not the slot: it stops applying the moment
-- that account leaves the person's record, and no full number is ever stored
-- (update-bank-info.md rule 22).
--
-- One OPEN report per (person, account): a second report on the same account
-- withdraws the first as 'superseded', so the history is kept.
--
-- RLS ON with NO policies: service role only (the anon key ships in the page's
-- JavaScript; memory anon-key-reads-bank-accounts).
--
-- No BEGIN/COMMIT here: the apply script owns the transaction, and its dry run
-- wraps this file in one it always rolls back.
-- Apply with: node --import tsx scripts/apply-payout-account-reports-migration.mts --apply
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.payout_account_reports (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  work_email          text        NOT NULL,
  account_kind        text        NOT NULL,
  account_fingerprint text        NOT NULL,
  account_hint        text        NOT NULL,
  account_label       text,
  status              text        NOT NULL,
  note                text,
  reported_via        text        NOT NULL,
  reported_by         text        NOT NULL,
  ip_address          text,
  reported_at         timestamptz NOT NULL DEFAULT now(),
  withdrawn_at        timestamptz,
  withdrawn_via       text,
  CONSTRAINT payout_account_reports_email_lower CHECK (work_email = lower(btrim(work_email)) AND work_email <> ''),
  CONSTRAINT payout_account_reports_kind_check CHECK (account_kind IN ('bank_primary', 'bank_alternative', 'wallet')),
  CONSTRAINT payout_account_reports_fingerprint_hex CHECK (account_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT payout_account_reports_status_check CHECK (status IN ('closed', 'deactivated', 'frozen', 'other')),
  CONSTRAINT payout_account_reports_note_len CHECK (note IS NULL OR char_length(note) <= 500),
  CONSTRAINT payout_account_reports_other_needs_note CHECK (status <> 'other' OR (note IS NOT NULL AND char_length(btrim(note)) >= 3)),
  CONSTRAINT payout_account_reports_via_check CHECK (reported_via IN ('external_link', 'employee_dashboard')),
  CONSTRAINT payout_account_reports_withdrawn_pair CHECK ((withdrawn_at IS NULL) = (withdrawn_via IS NULL)),
  CONSTRAINT payout_account_reports_withdrawn_via_check CHECK (withdrawn_via IS NULL OR withdrawn_via IN ('external_link', 'employee_dashboard', 'superseded'))
);

COMMENT ON TABLE public.payout_account_reports IS
  '[PAYOUT-ACCOUNT-REPORTS] An employee''s own report that one of their payout accounts is closed, deactivated, frozen or otherwise unusable. Informs Accounting; never changes routing. The account is an HMAC fingerprint + masked hint, never the number. docs/features/payout-account-reports.md';

-- At most one OPEN report per person per account.
CREATE UNIQUE INDEX IF NOT EXISTS payout_account_reports_one_open
  ON public.payout_account_reports (work_email, account_fingerprint)
  WHERE withdrawn_at IS NULL;

CREATE INDEX IF NOT EXISTS payout_account_reports_email_idx
  ON public.payout_account_reports (work_email, reported_at DESC);

ALTER TABLE public.payout_account_reports ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';

-- Verify:
--   SELECT relrowsecurity FROM pg_class WHERE oid = 'public.payout_account_reports'::regclass;  -- true
--   SELECT count(*) FROM pg_policies WHERE tablename = 'payout_account_reports';               -- 0
