-- Migration: offboarded_sheet.origin  (HRIS vs Google Sheet)
-- Created: 2026-08-28
--
-- WHY THIS EXISTS
-- ---------------
-- HR Offboarding carried TWO tables of leavers that are really one population:
--
--   * "Offboarded by HRIS"  = `offboarding_queue` rows with status='completed'
--   * "Offboarded"          = the `offboarded_sheet` ledger
--
-- They were never disjoint. `/api/hr/offboard` writes BOTH — measured
-- 2026-08-28, all 488 completed queue rows already exist in `offboarded_sheet`,
-- so the queue tab added exactly ZERO people and the split was presentational,
-- not a real division of the data. Merging them into one list needs only one
-- thing the table could not answer: WHERE DID THIS RECORD COME FROM.
--
-- That question was answerable by accident and about to stop being. The live
-- split on 2026-08-28:
--
--   off_boarded_by IS NOT NULL   491 rows   synced_at all 2026-07 / 2026-08
--   off_boarded_by IS NULL     3,354 rows   synced_at all 2026-06
--
-- Two independent signals agreeing perfectly, because the Google Sheet intake
-- was retired on 2026-08-07 (sync-offboarded-from-sheet is a 410 tombstone):
-- every row written since carries the HR actor who pressed the button, and
-- every row before it is the last snapshot the sync ever took (2026-06-09).
-- Both signals are ACCIDENTS of that history. `off_boarded_by` is nullable and
-- a legacy HRIS row could have lacked one; `synced_at` defaults to now() and
-- says when the row was WRITTEN, never where it came from. Neither is a
-- provenance column, and the moment sheet-origin rows are imported again both
-- stop working — an imported row is written today (2026-08 `synced_at`) with no
-- actor (NULL `off_boarded_by`), which under the old heuristic reads as
-- "modern HRIS row with a missing actor". So provenance gets STORED, once,
-- while the accident still tells the truth, rather than re-derived per query
-- from signals that will have gone stale.
--
-- WHAT THIS IS *NOT*
-- ------------------
-- This does NOT reopen the Google Sheet as a SYNC source. The tombstone stands:
-- nothing polls the spreadsheet, nothing bulk-REPLACES this table from it, and
-- the typo that motivated the retirement (franm@simple.biz stamped 2027-04-20,
-- a year-typo for 2026, hand-fixed in the DB at id 45266) can no longer be
-- copied back over by a scheduler. The companion import
-- (scripts/import-offboarded-from-json.mjs) is INSERT-ONLY and one-off: it
-- refuses to touch a row that already exists, which is precisely what keeps
-- that fix — and every other hand-correction in this table — durable.
--
-- WHY NOT NULLABLE
-- ----------------
-- A NULL origin is the same unanswerable state this migration exists to
-- remove, and it would land silently on every future INSERT that forgets the
-- column. NOT NULL DEFAULT 'hris' makes the safe answer automatic: anything
-- written by this application is HRIS-authored by definition, and the only
-- writer that says otherwise is the one-off import, which is explicit about it.
-- The CHECK keeps the column a two-valued fact instead of drifting into free
-- text the way `off_boarded_reason` did (30 distinct values, both casings, and
-- three that are not departures at all).
--
-- NO BEGIN/COMMIT HERE, DELIBERATELY. scripts/apply-offboarded-origin-migration.mjs
-- owns the transaction: its --dry mode wraps this file in a transaction it always
-- rolls back, and a COMMIT in here would end that transaction and make the
-- rehearsal permanent -- a --dry that silently applies is worse than no --dry at
-- all. pg runs a multi-statement query in one implicit transaction anyway, so a
-- real apply is still all-or-nothing.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + DROP/ADD CONSTRAINT + a backfill that
-- only touches rows still lacking a value. Re-running is a no-op.

-- 1. Add the column NULLABLE first, so the backfill can distinguish
--    "not yet classified" (NULL) from a real answer. A NOT NULL DEFAULT here
--    would stamp all 3,845 existing rows 'hris' before we could look at them.
ALTER TABLE public.offboarded_sheet
  ADD COLUMN IF NOT EXISTS origin text;

-- 2. Backfill from the accident, while the accident is still true.
--    An HR actor on the row means /api/hr/offboard wrote it: that route is the
--    only writer that sets off_boarded_by, and it has been the ONLY writer of
--    this table since 2026-08-07.
UPDATE public.offboarded_sheet
   SET origin = 'hris'
 WHERE origin IS NULL
   AND off_boarded_by IS NOT NULL;

--    Everything else is the 2026-06-09 snapshot the retired sync left behind.
UPDATE public.offboarded_sheet
   SET origin = 'google_sheet'
 WHERE origin IS NULL;

-- 3. Lock it down. DEFAULT 'hris' is deliberate: an INSERT from this
--    application that says nothing about provenance IS an HRIS offboard.
ALTER TABLE public.offboarded_sheet
  ALTER COLUMN origin SET DEFAULT 'hris';

ALTER TABLE public.offboarded_sheet
  ALTER COLUMN origin SET NOT NULL;

ALTER TABLE public.offboarded_sheet
  DROP CONSTRAINT IF EXISTS offboarded_sheet_origin_check;

ALTER TABLE public.offboarded_sheet
  ADD CONSTRAINT offboarded_sheet_origin_check
  CHECK (origin IN ('hris', 'google_sheet'));

-- 4. The merged HR tab filters by origin and shows a per-origin count on every
--    render; 3,845 rows do not need an index to be fast, but this table only
--    grows and the filter is the tab's primary control.
CREATE INDEX IF NOT EXISTS offboarded_sheet_origin_idx
  ON public.offboarded_sheet (origin);

COMMENT ON COLUMN public.offboarded_sheet.origin IS
  'How this record was authored: ''hris'' = written by /api/hr/offboard (the '
  'HRIS offboarding flow); ''google_sheet'' = came off the master sheet''s '
  'Offboarded tab (the 2026-06-09 snapshot left by the retired sync, plus the '
  '2026-08-28 one-off JSON import). NOT a live sync flag - nothing polls the '
  'spreadsheet; see app/api/cron/sync-offboarded-from-sheet/route.ts.';
