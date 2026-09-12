-- Paystub issues — one row per time a pay statement was actually EMAILED (2026-09-12).
--
-- Until today `paystub_dispatch_queue.send_count` was the only trace that a
-- statement had gone out more than once: a bare integer, read by no UI, that
-- cannot say WHEN each issue went, for HOW MUCH, WHO sent it, or WHY. That is
-- the whole of the ask — "attempt #2 or something better" — so the count alone
-- could not answer it.
--
-- THE SNAPSHOT IS THE POINT. `amount_php` here is the total that was actually on
-- the emailed statement, not the queue row's current figure. It is what makes the
-- NEXT issue's verdict decidable: figures unchanged => "Reissued", figures moved
-- => "Amended". Without a per-issue snapshot the two are indistinguishable, and
-- "Amended" is the only word that tells an employee they must re-read the
-- document. Compare against the PREVIOUS ISSUE, never against the staged payload
-- — the route's existing stub-vs-payment reconciliation is a different question.
--
-- DISPLAY + AUDIT ONLY, exactly like bonus_catalog_bonus_history: the money path
-- is untouched, `paystub_dispatch_queue` keeps `send_count`/`sent_at` as the live
-- state, and a failed insert here must never fail a payment or block an email.
--
-- NO BACKFILL. The 117 rows that already carry send_count >= 2 get a count and no
-- history; the UI labels them "Issue N" with no word attached, because inventing
-- a per-issue amount to justify "Reissued" or "Amended" would be a guess printed
-- on a pay document. A row that is not here means "not recorded", never "issue 1".
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS. Touches no existing row.
-- NOTE: this file carries NO BEGIN/COMMIT on purpose — the apply script owns the
-- transaction, and a COMMIT inside the file would end it from within, so the
-- "dry run" would commit to production (that happened on 2026-09-11 with
-- employee_gift_receipts).

create table if not exists public.paystub_issues (
  id                   bigserial     primary key,

  -- Identity of the statement. Mirrors paystub_dispatch_queue's natural key.
  cycle_source_file    text          not null,
  recipient_email      text          not null,

  -- 1-based. Issue 1 is the original send; 2+ is a reissue or an amendment.
  issue_no             integer       not null,

  issued_at            timestamptz   not null default now(),
  -- The signed-in clerk, or a script's own actor string. Nullable only because
  -- the resend route predates the actor-integrity sweep; new writes always set it.
  issued_by            text,

  -- 'original' | 'reissued' | 'amended' | 'unrecorded'. NEVER 'attempt' — an
  -- attempt implies the previous one failed, which is false in the ordinary
  -- undo-then-repay case. Constrained so a future writer cannot invent a word
  -- the UI has no copy for.
  --
  -- 'unrecorded' is a REAL stored verdict, distinct from an absent row:
  --   no row at all   → this issue was never recorded (everything before today)
  --   kind 'unrecorded' → this issue WAS recorded, but the previous issue's
  --                       total was unknown, so no comparison was possible
  -- Both render as the number alone. Storing it is what lets the NEXT issue be
  -- classified properly: the row still snapshots the amount it emailed, which
  -- bootstraps history for a statement that had none.
  kind                 text          not null
                       check (kind in ('original', 'reissued', 'amended', 'unrecorded')),

  -- The totals ACTUALLY EMAILED on this issue.
  amount_php           numeric(14,2),
  amount_usd           numeric(14,2),
  -- What the previous issue said, copied forward so a single row explains itself
  -- without a self-join. Null on issue 1.
  previous_amount_php  numeric(14,2),

  -- Which surface sent it, and any note the clerk attached.
  source               text          not null default 'mark_paid'
                       check (source in ('mark_paid', 'resend', 'other')),
  reason               text,

  -- One row per issue number per statement. Makes a double-write from a retried
  -- request land as a conflict rather than as a phantom extra issue.
  constraint paystub_issues_unique_issue
    unique (cycle_source_file, recipient_email, issue_no)
);

-- The employee pay-stub list reads every issue for one person across all weeks;
-- the dispatch UI reads one (file, person). This index serves both.
create index if not exists paystub_issues_recipient_idx
  on public.paystub_issues (recipient_email, cycle_source_file, issue_no desc);

comment on table public.paystub_issues is
  'One row per pay statement actually emailed. amount_php is the total ON THAT EMAIL — it is what makes the next issue decidable as Reissued (unchanged) vs Amended (moved). Display/audit only; never a second source of truth for pay. No row = not recorded, never issue 1.';
