-- Migration: payroll_wizard_notes — "Adjustment" column, per-week history,
--            and the worker→email link behind the Adjustment bridge
-- Created: 2026-07-17
--
-- Three additions to the Payroll Wizard's Notes checklist:
--
--   adjustment   TEXT — new column between Worker and Notes: the concrete pay
--                       change the note calls for (e.g. "+₱500", "-2 hrs"),
--                       with Notes keeping the free-form context. Free text
--                       like every other column.
--
--   week_start   DATE — Monday (Asia/Manila) of the payroll week the note was
--                       WRITTEN. Stamped by the API on Add Row and when a
--                       blank seeded line is first filled in; never editable
--                       from the client. Drives the board's new period
--                       selector (current live week vs. past weeks).
--
--   worker_email TEXT — work email behind the Worker text, set when a worker
--                       is picked from the board's new suggestion list (Global
--                       Master List + recently offboarded) or bridged from the
--                       wizard. Links a row to the Additions tab's "Adj."
--                       override so the two hold the adjustment together.
--
-- Backfill: existing rows with any content (or already ticked Done) are filed
-- under the Manila week of their created_at. Blank seeded lines stay NULL —
-- they'll be stamped when someone actually writes on them.
--
-- Idempotent: rerunning is safe (the backfill only touches NULL week_start).

BEGIN;

ALTER TABLE public.payroll_wizard_notes
  ADD COLUMN IF NOT EXISTS adjustment TEXT,
  ADD COLUMN IF NOT EXISTS week_start DATE,
  ADD COLUMN IF NOT EXISTS worker_email TEXT;

-- The wizard→board bridge looks up "this worker's live-week row".
CREATE INDEX IF NOT EXISTS payroll_wizard_notes_worker_week_idx
  ON public.payroll_wizard_notes (worker_email, week_start);

UPDATE public.payroll_wizard_notes
SET week_start = date_trunc('week', (created_at AT TIME ZONE 'Asia/Manila'))::date
WHERE week_start IS NULL
  AND (
    done
    OR COALESCE(BTRIM(note_date), '') <> ''
    OR COALESCE(BTRIM(worker), '') <> ''
    OR COALESCE(BTRIM(notes), '') <> ''
  );

COMMIT;
