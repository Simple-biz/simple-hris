-- Migration: MESA receipt values + payroll obligations
-- Created: 2026-08-27
--
-- WHY THIS EXISTS
-- ---------------
-- Two MESA mechanisms settle through PAYROLL rather than through the fund, and
-- neither had anywhere to live before this migration.
--
--   1) RECEIPT SHORTFALL. A disbursement is a draw against the member's own
--      balance for a real emergency. If the receipts they produce are worth AT
--      LEAST what they asked for, the money is theirs and nothing is owed. If
--      the receipts come up SHORT -- or never arrive at all -- the difference
--      must be returned, taken from their next paycheck as a salary deduction.
--      Nothing recorded either half of that: `mesa_request_receipts` stored the
--      FILES but never their VALUE, so "is this draw fully substantiated?" was
--      unanswerable from the database, and `mesa_requests` recorded only that
--      money went out (docs/features/mesa.md:129 -- "a disbursement only adds
--      to pay").
--
--      This is exactly the shape of the live data. Across the 2026-08-27 MESA
--      export, every recorded payback is smaller than the member's total draws:
--        ruthb      drew  3,000 -> returned 3,000  (no receipt at all)
--        jupitero   drew  3,000 -> returned   300  (receipts covered 2,700)
--        jomarl     drew  8,000 -> returned   458  (receipts covered 7,542)
--        ralf       drew 28,500 -> returned 6,942  (receipts covered 21,558)
--      and the other 138 draws returned nothing, because their receipts covered
--      the full amount. A shortfall, never a loan repayment.
--
--   2) OFFBOARD PAYOUT. When a member leaves, their whole MESA balance is added
--      to their final paycheck. MESA had ZERO coupling to offboarding before
--      this -- no reference in src/lib/offboard*, app/api/offboard*, or
--      docs/features/payroll-wizard-final-pay.md -- so a leaver's balance just
--      sat in a closed account.
--
-- Both are the same shape: "payroll must move exactly this much, exactly once."
-- One table gives the Payroll Wizard a single question to ask per employee per
-- week, and gives every obligation exactly one settlement stamp.
--
-- WHAT THIS IS *NOT*
-- ------------------
-- This is NOT a second ledger. `mesa_ledger` stays a faithful 1:1 mirror of the
-- external MESA tracker (docs/features/mesa.md:24) and remains the record of
-- money in and out of the fund. This table records only the PAYROLL INSTRUCTION
-- and whether it has been carried out; the money event still lands in the
-- ledger when the obligation settles.
--
-- INVARIANTS ENFORCED HERE, not in application code, so they cannot drift:
--   * kind and direction must agree -- a shortfall is always taken FROM pay, an
--     offboard payout is always added TO pay. Neither can be inverted.
--   * amount is strictly positive; direction carries the sign, never the amount.
--     A zero-value obligation is the "receipts covered it" case, which must be
--     the ABSENCE of a row, not a row worth nothing.
--   * settlement is atomic -- settled_at and settled_week_end are both set or
--     both null. A half-settled row cannot exist.
--   * the week model is Sun-Sat, so every week-end date must be a SATURDAY
--     (memory/pab-calendars-sun-sat-sweep). A Monday-anchored week parses fine
--     and strands rows everywhere else in this codebase; it is rejected here.
--   * at most ONE UNSETTLED shortfall per source disbursement, and at most ONE
--     UNSETTLED payout per member -- as partial unique indexes, not application
--     count checks a double-submit could race past (the same reasoning as the
--     3-file receipt cap, docs/features/mesa.md:97).
--
-- Idempotent: safe to re-run.


-- == 1) What each receipt is actually WORTH =================================
-- The file proves the spend; this column records how much it proves. Nullable
-- because a member attaches the file and Accounting values it during review --
-- an unvalued receipt is an open question, which is different from a receipt
-- worth nothing, and collapsing those two would silently forgive real debt.

ALTER TABLE public.mesa_request_receipts
  ADD COLUMN IF NOT EXISTS amount_php numeric(12,2);

ALTER TABLE public.mesa_request_receipts
  DROP CONSTRAINT IF EXISTS mesa_receipt_amount_positive_chk;
ALTER TABLE public.mesa_request_receipts
  ADD  CONSTRAINT mesa_receipt_amount_positive_chk
  CHECK (amount_php IS NULL OR amount_php >= 0);

COMMENT ON COLUMN public.mesa_request_receipts.amount_php IS
  'The value Accounting read off this receipt, in PHP. Summed across a disbursement''s receipts and compared to mesa_requests.amount_needed: covered in full means the money is the member''s and nothing is owed; short means the difference is deducted from their next paycheck. NULL = attached but not yet valued, which is NOT the same as zero.';


-- == 2) What payroll must do about it ======================================

CREATE TABLE IF NOT EXISTS public.mesa_payroll_obligations (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  email             text          NOT NULL,  -- lowercased WORK email (ledger/accounts key)
  account_number    text,                    -- mesa_accounts.account_number this settles against

  kind              text          NOT NULL,  -- 'receipt_shortfall' | 'offboard_payout'
  direction         text          NOT NULL,  -- 'deduct' (from pay) | 'credit' (to pay)
  amount_php        numeric(12,2) NOT NULL,

  -- The disbursement that came up short. ON DELETE SET NULL because the money
  -- has already moved: losing the workflow row must never erase the debt. A
  -- dispatched request cannot be deleted at all (docs/features/mesa.md:65) and
  -- a shortfall only exists after dispatch, so this should stay populated.
  source_request_id uuid          REFERENCES public.mesa_requests(id) ON DELETE SET NULL,

  -- Frozen at raise time. Kept so the arithmetic stays auditable after the fact
  -- and so re-valuing a receipt later cannot silently restate a debt that has
  -- already been taken out of someone's pay.
  requested_php     numeric(12,2),
  receipted_php     numeric(12,2),

  due_week_end      date          NOT NULL,  -- Sun-Sat week end whose paycheck settles this
  settled_at        timestamptz,
  settled_week_end  date,
  settled_by        text,
  notes             text,
  created_at        timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT mesa_obligation_kind_chk
    CHECK (kind IN ('receipt_shortfall', 'offboard_payout')),

  CONSTRAINT mesa_obligation_direction_chk
    CHECK (direction IN ('deduct', 'credit')),

  -- A shortfall is always taken FROM pay; an offboard payout is always added TO
  -- pay. This pairing is the point of the table and cannot be inverted.
  CONSTRAINT mesa_obligation_kind_direction_chk
    CHECK (
      (kind = 'receipt_shortfall' AND direction = 'deduct')
      OR
      (kind = 'offboard_payout'   AND direction = 'credit')
    ),

  -- Direction carries the sign. "Receipts covered it" is the absence of a row,
  -- never a row worth zero, so that a settled-nothing can't read as settled-debt.
  CONSTRAINT mesa_obligation_amount_positive_chk
    CHECK (amount_php > 0),

  -- You cannot owe back more than you drew.
  CONSTRAINT mesa_obligation_shortfall_within_request_chk
    CHECK (
      kind <> 'receipt_shortfall'
      OR requested_php IS NULL
      OR amount_php <= requested_php
    ),

  -- Settlement is atomic: no half-settled row.
  CONSTRAINT mesa_obligation_settlement_atomic_chk
    CHECK (
      (settled_at IS NULL     AND settled_week_end IS NULL)
      OR
      (settled_at IS NOT NULL AND settled_week_end IS NOT NULL)
    ),

  -- Sun-Sat week model: a week end is a Saturday. dow: Sunday=0 .. Saturday=6.
  CONSTRAINT mesa_obligation_due_week_is_saturday_chk
    CHECK (EXTRACT(DOW FROM due_week_end) = 6),

  CONSTRAINT mesa_obligation_settled_week_is_saturday_chk
    CHECK (settled_week_end IS NULL OR EXTRACT(DOW FROM settled_week_end) = 6)
);

COMMENT ON TABLE public.mesa_payroll_obligations IS
  'What MESA requires of payroll, and whether it has happened. One row per obligation: a receipt shortfall (deducted from the next paycheck when receipts did not cover a disbursement) or an offboard payout (the leaver''s whole balance added to their final paycheck). NOT a ledger -- mesa_ledger stays the record of money in/out of the fund; this records the payroll instruction and its settlement.';
COMMENT ON COLUMN public.mesa_payroll_obligations.direction IS
  'deduct = taken FROM pay (receipt shortfall). credit = added TO pay (offboard payout). Direction carries the sign; amount_php is always positive.';
COMMENT ON COLUMN public.mesa_payroll_obligations.due_week_end IS
  'The Sun-Sat week end (a SATURDAY) whose paycheck must settle this. For a shortfall this is the week AFTER the shortfall was determined -- "they return it using their next paycheck".';
COMMENT ON COLUMN public.mesa_payroll_obligations.settled_at IS
  'Stamped when the Payroll Wizard carries the obligation into a pay run. NULL = still outstanding. Paired with settled_week_end so a half-settled row cannot exist.';

-- The Wizard's hot path: "what does this person owe, or what are they owed, now?"
CREATE INDEX IF NOT EXISTS mesa_obligations_open_by_email_idx
  ON public.mesa_payroll_obligations (lower(email))
  WHERE settled_at IS NULL;

-- Sweeping a pay week for everything it must settle.
CREATE INDEX IF NOT EXISTS mesa_obligations_open_by_week_idx
  ON public.mesa_payroll_obligations (due_week_end)
  WHERE settled_at IS NULL;

-- A disbursement can carry at most ONE outstanding shortfall. Re-raising after
-- settlement is fine; two live debts for one draw is not.
CREATE UNIQUE INDEX IF NOT EXISTS mesa_obligations_one_open_shortfall_per_request
  ON public.mesa_payroll_obligations (source_request_id)
  WHERE settled_at IS NULL AND kind = 'receipt_shortfall' AND source_request_id IS NOT NULL;

-- A member can have at most ONE outstanding offboard payout. Without this, two
-- offboard runs -- or a re-offboard after a re-hire -- pay the balance twice.
CREATE UNIQUE INDEX IF NOT EXISTS mesa_obligations_one_open_payout_per_email
  ON public.mesa_payroll_obligations (lower(email))
  WHERE settled_at IS NULL AND kind = 'offboard_payout';
