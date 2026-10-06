-- MESA contribution suspensions (Kane, 2026-10-06): Accounting -> MESA -> Active Members can
-- SUSPEND a member's weekly contribution from an effective date — the PHP 100 deduction AND the
-- PHP 100 + 300 deposit stop — without opting them out. The member keeps their account, account
-- number and balance; nothing is released or paid out. RESUME restarts it from its own date.
--
-- Apply with: node --import tsx scripts/apply-mesa-suspensions-migration.mts --apply
-- (no flag = rehearse inside a rolled-back transaction; --verify = check only). Safe to run BEFORE
-- or AFTER deploying: until the table exists every engine reads "no suspensions" (today's
-- behaviour) and the Suspend button is disabled with "not set up yet".
--
-- One row = one suspension WINDOW on one account. A pay week is suspended when its FRIDAY deposit
-- date d satisfies  suspended_from <= d < resumed_on  (resumed_on NULL = still suspended) —
-- `mesaContributesForWeek` in src/lib/mesa/deposit-date.ts, Kane's 2026-09-15 "Friday should be
-- the deposit dates" ruling applied to both ends. resumed_on = suspended_from is a cancelled
-- suspension: the window is empty and no week is skipped.
--
-- Keyed to the ACCOUNT, not the person: opting out closes the account and every window on it goes
-- inert with it; a re-join opens a new account number with no suspension. Readers only consult
-- windows whose account is still open (src/lib/supabase/mesa-suspensions.ts).
--
-- Idempotent: CREATE ... IF NOT EXISTS; constraints are named and re-created. No existing row of
-- any other table is touched.

CREATE TABLE IF NOT EXISTS public.mesa_suspensions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The stint this suspends. ON DELETE RESTRICT: an account row is never deleted (opt-out CLOSES
  -- it), and a suspension must not outlive silently the account it explains.
  account_number  text        NOT NULL REFERENCES public.mesa_accounts(account_number) ON DELETE RESTRICT,
  -- mesa_accounts.email at suspend time (the ledger/account key), lowercased.
  email           text        NOT NULL,
  -- The roster address Accounting acted on, lowercased. Differs from `email` only for a member
  -- whose MESA identity is an earlier address (src/data/mesa-email-aliases.json).
  roster_email    text,

  suspended_from  date        NOT NULL,
  resumed_on      date,
  reason          text,

  suspended_by    text        NOT NULL,
  suspended_at    timestamptz NOT NULL DEFAULT now(),
  resumed_by      text,
  resumed_at      timestamptz,

  CONSTRAINT mesa_suspensions_resume_after_start_chk
    CHECK (resumed_on IS NULL OR resumed_on >= suspended_from),

  -- A resume is a decision someone made: the date, who and when travel together.
  CONSTRAINT mesa_suspensions_resume_pair_chk
    CHECK ((resumed_on IS NULL) = (resumed_by IS NULL) AND (resumed_on IS NULL) = (resumed_at IS NULL)),

  CONSTRAINT mesa_suspensions_reason_len_chk
    CHECK (reason IS NULL OR char_length(reason) <= 250),

  CONSTRAINT mesa_suspensions_email_lower_chk
    CHECK (email = lower(email) AND (roster_email IS NULL OR roster_email = lower(roster_email)))
);

-- At most ONE open (not yet resumed) window per account, so Resume always knows which row it ends
-- and a double-click on Suspend cannot open two. Overlap between CLOSED windows is refused by the
-- route; it could not change money anyway (a week is suspended when ANY window covers its Friday).
CREATE UNIQUE INDEX IF NOT EXISTS mesa_suspensions_one_open_per_account
  ON public.mesa_suspensions (account_number)
  WHERE resumed_on IS NULL;

CREATE INDEX IF NOT EXISTS mesa_suspensions_account_idx
  ON public.mesa_suspensions (account_number, suspended_from);

COMMENT ON TABLE public.mesa_suspensions IS
  'MESA contribution suspension windows. A pay week whose Friday deposit date d has suspended_from <= d < resumed_on (NULL = open) is neither charged the PHP 100 nor credited the PHP 100 + 300. The member stays enrolled; balance and account are untouched. Only windows on an OPEN mesa_accounts row are read.';
COMMENT ON COLUMN public.mesa_suspensions.suspended_from IS
  'Effective date picked by Accounting. Weeks whose Friday deposit date is on/after it are suspended. Not floored at today; weeks already snapshotted keep their PHP 100 (forward-only).';
COMMENT ON COLUMN public.mesa_suspensions.resumed_on IS
  'Effective date of Resume. Weeks whose Friday deposit date is on/after it contribute again. NULL = still suspended. Equal to suspended_from = cancelled (no week skipped).';

-- Lock-down: service role only. The routes read and write it with the service-role client; no
-- browser client ever touches it.
ALTER TABLE public.mesa_suspensions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mesa_suspensions FROM anon, authenticated;
