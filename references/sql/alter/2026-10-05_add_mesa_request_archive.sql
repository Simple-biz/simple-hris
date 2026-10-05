-- Adds archive state to mesa_requests: Accounting -> MESA -> Requests can move a
-- COMPLETED request out of the main view into an Archived view (tickets board,
-- 2026-10-05). Nothing is deleted; archiving is reversible (Unarchive).
--
-- Apply with: node --import tsx scripts/apply-mesa-request-archive-migration.mts --apply
-- (no flag = rehearse inside a rolled-back transaction). Safe to run BEFORE or AFTER
-- deploying: until the columns exist the Requests tab shows every row as active and
-- the Archive call answers 503 "not set up yet".
--
-- "Completed" is defined once in src/lib/mesa/request-archive.ts and restated here as
-- a CHECK, so an archived row can never be one that still has something left to do —
-- the database refuses it even if a route forgets to ask:
--   denied                                  -> may be archived
--   approved opt_out / opt_in               -> may be archived
--   approved disbursement WITH dispatched_at -> may be archived (paid)
--   approved disbursement, not dispatched   -> NO (money still owed)
--   approved return                         -> NO (nothing takes it from a paycheck yet)
--   pending                                 -> NO
-- The same CHECK means a revoke (status -> pending) or a dispatch undo
-- (dispatched_at -> NULL) on an archived row is refused until the row is unarchived;
-- the dispatch-undo route clears the archive first, because an undone payout is owed
-- again and must be back in the main view.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; the constraints are dropped and re-added by name.
-- No existing row is modified (both columns default to NULL = not archived).

ALTER TABLE public.mesa_requests
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by text;

ALTER TABLE public.mesa_requests
  DROP CONSTRAINT IF EXISTS mesa_requests_archive_pair_chk;
ALTER TABLE public.mesa_requests
  ADD CONSTRAINT mesa_requests_archive_pair_chk
  CHECK ((archived_at IS NULL) = (archived_by IS NULL));

ALTER TABLE public.mesa_requests
  DROP CONSTRAINT IF EXISTS mesa_requests_archive_only_completed_chk;
ALTER TABLE public.mesa_requests
  ADD CONSTRAINT mesa_requests_archive_only_completed_chk
  CHECK (
    archived_at IS NULL
    OR status = 'denied'
    OR (status = 'approved' AND request_type IN ('opt_out', 'opt_in'))
    OR (status = 'approved' AND request_type = 'disbursement' AND dispatched_at IS NOT NULL)
  );

COMMENT ON COLUMN public.mesa_requests.archived_at IS
  'When Accounting archived this COMPLETED request out of the MESA Requests main view. NULL = active. Reversible (Unarchive clears it). Only a completed request may carry it (mesa_requests_archive_only_completed_chk).';
COMMENT ON COLUMN public.mesa_requests.archived_by IS
  'Session email of whoever archived the request. Set and cleared together with archived_at.';
