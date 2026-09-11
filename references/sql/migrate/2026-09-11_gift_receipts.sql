-- [GIFT-RECEIPTS]
-- `employee_gift_receipts` — the tenure-gift FULFILMENT ledger.
-- Created: 2026-09-11. Kane's ruling, session brief 1(b) · 2(b) · 3(a).
--
-- WHAT THIS CLOSES
-- ----------------
-- Until today HRIS could not answer "who has and hasn't received a gift". The
-- only lifecycle on `employee_gift_shipping_details` is ADDRESS REVIEW
-- (pending/approved/rejected) and "Approve" explicitly does NOT mean gifted
-- (src/lib/supabase/employee-gift-shipping.ts:183-191). There was no
-- shipped_at / received_at / fulfilled column anywhere. The answer lived only in
-- a Google Sheet.
--
-- This table is that answer, and as of today HRIS — not the sheet — is the
-- ledger of record for it.
--
-- THE KEY IS `work_email`, DELIBERATELY
-- -------------------------------------
-- `employee_gift_shipping_details` is UNIQUE (personal_email, milestone_index),
-- and personal_email is NOT injective on this roster: russell@simple.biz and
-- johnc@simple.biz share one personal email, and greyg@simple.biz has none at
-- all. Keying fulfilment on personal_email would silently merge two people's
-- gift history and drop a third person entirely. Work email is unique across
-- all 1,229 rows of the source sheet and across the master list, and it is also
-- the column the source file keys on. Fulfilment therefore lives in its OWN
-- table rather than as columns on the submissions table.
--
-- A ROW IS AN ASSERTION. ABSENCE IS "UNKNOWN", NEVER "NOT RECEIVED".
-- ------------------------------------------------------------------
-- Exactly three states are representable, and the third one is the point:
--
--   received = true   somebody stated this gift was given.
--   received = false  somebody stated this gift was NOT given, for a milestone
--                     that had ALREADY COME DUE when they stated it. This is
--                     the backlog — what Simple owes.
--   no row            nobody has stated anything. UNKNOWN.
--
-- The import therefore does NOT write a `false` row for a milestone still in the
-- future: the source file's "No" in that column is a spreadsheet default, not an
-- assertion of fact, and recording it as one would invent 8,398 findings. 239
-- active people are absent from the source file entirely and correctly get no
-- rows at all — they must render as Unknown, never as "not received".
--
-- `source_milestone_date` IS EVIDENCE, NOT A DATE RULE
-- ----------------------------------------------------
-- It records the milestone date the SOURCE claimed, so a later divergence is
-- recoverable (3 cells of the 2026-09-11 import disagree with HRIS by one day,
-- month-end rollover: Sep 30 + 6mo is Mar 31 here and Mar 30 in the sheet).
-- Which milestone is DUE is always recomputed by src/lib/gift-milestones.ts.
-- The column is named `source_*` so it cannot be mistaken for the second date
-- rule that docs/features/gift-tracker-shipping-export.md forbids.
--
-- NO PRICE. Tenure gifts have carried no price or payment since 2026-07-14
-- (memory/gift-feature-info-only). Nothing here is money and nothing here
-- reaches dispatch.
--
-- Idempotent: rerunning is safe. Applied by
-- scripts/apply-gift-receipts-migration.mts (--dry by default, --apply commits).
--
-- NO `BEGIN` / `COMMIT` IN THIS FILE, DELIBERATELY. The apply script opens the
-- transaction and, on a dry run, rolls it back. A `COMMIT` in here would end
-- that transaction from the inside: the rehearsal would COMMIT to production and
-- the script's own ROLLBACK would then have nothing to undo. Every sibling
-- migration under references/sql/migrate/ omits them for the same reason.

CREATE TABLE IF NOT EXISTS public.employee_gift_receipts (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Lower-cased + trimmed by trg_egr_normalize before every write.
  work_email            TEXT        NOT NULL,

  -- N = the (N x 6)-month gift. 1 = 6-month, 2 = 12-month, ... Capped at 60 to
  -- match the loop bound in src/lib/gift-milestones.ts (30 years).
  milestone_index       INT         NOT NULL,

  -- The assertion itself. NOT NULL: there is no "maybe" — that state is the
  -- ABSENCE of a row, which is why this column must never become nullable.
  received              BOOLEAN     NOT NULL,

  -- Evidence only. Never used to decide which milestone is due.
  source_milestone_date DATE,

  source                TEXT        NOT NULL,
  -- Provenance for an imported fact: which file said so.
  source_file           TEXT,

  note                  TEXT        NOT NULL DEFAULT '',

  -- Every assertion has an author. The PAB-exclusion table shipped without one
  -- and 107 person-months are permanently unattributable as a result. Not
  -- repeating that here.
  recorded_by           TEXT        NOT NULL,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT employee_gift_receipts_milestone_range
    CHECK (milestone_index >= 1 AND milestone_index <= 60),
  CONSTRAINT employee_gift_receipts_work_email_normalized
    CHECK (work_email = lower(btrim(work_email)) AND work_email <> ''),
  CONSTRAINT employee_gift_receipts_work_email_shape
    CHECK (work_email LIKE '%_@_%'),
  CONSTRAINT employee_gift_receipts_source_check
    CHECK (source IN ('sheet_import', 'hris')),
  -- An imported fact with no file behind it cannot be re-checked against
  -- anything, which is how the sheet became unauditable in the first place.
  CONSTRAINT employee_gift_receipts_source_file_present
    CHECK (source <> 'sheet_import' OR (source_file IS NOT NULL AND source_file <> '')),
  CONSTRAINT employee_gift_receipts_recorded_by_present
    CHECK (btrim(recorded_by) <> ''),

  CONSTRAINT employee_gift_receipts_person_milestone_key
    UNIQUE (work_email, milestone_index)
);

COMMENT ON TABLE public.employee_gift_receipts IS
  '[GIFT-RECEIPTS] Tenure-gift fulfilment ledger, keyed by WORK email because personal_email is not injective on this roster. A row is an assertion; NO ROW MEANS UNKNOWN, never "not received". received=false is only written for a milestone already due. Backfilled by scripts/backfill-gift-receipts.mts. Doc: docs/features/gift-tracker-receipts.md';

COMMENT ON COLUMN public.employee_gift_receipts.source_milestone_date IS
  'The milestone date the SOURCE asserted — evidence only. Which milestone is due is always recomputed by src/lib/gift-milestones.ts.';

CREATE INDEX IF NOT EXISTS employee_gift_receipts_work_email_idx
  ON public.employee_gift_receipts (work_email);
CREATE INDEX IF NOT EXISTS employee_gift_receipts_received_idx
  ON public.employee_gift_receipts (received);
CREATE INDEX IF NOT EXISTS employee_gift_receipts_recorded_at_idx
  ON public.employee_gift_receipts (recorded_at DESC);

-- Lower-case the key and bump updated_at on every write. Mirrors
-- trg_egsd_normalize on employee_gift_shipping_details so the two tables cannot
-- disagree about what an email key looks like.
CREATE OR REPLACE FUNCTION public.employee_gift_receipts_normalize()
RETURNS TRIGGER AS $$
BEGIN
  NEW.work_email := lower(btrim(NEW.work_email));
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_egr_normalize ON public.employee_gift_receipts;
CREATE TRIGGER trg_egr_normalize
  BEFORE INSERT OR UPDATE ON public.employee_gift_receipts
  FOR EACH ROW EXECUTE FUNCTION public.employee_gift_receipts_normalize();

-- NEXT_PUBLIC_SUPABASE_ANON_KEY ships in the client bundle, and this table maps
-- a named worker to a thing the company failed to give them. House precedent for
-- a table like that is RLS ENABLED with NO policies — service-role only
-- (references/sql/create/create_screening.sql).
ALTER TABLE public.employee_gift_receipts ENABLE ROW LEVEL SECURITY;
