-- Migration: add 'failed_to_promote' status to hr_pending_employees
-- Generated: 2026-06-11
--
-- Why
--   Promotion now only marks a staged hire 'promoted' once BOTH halves landed:
--   the global_master_list row (Supabase) AND the master Google Sheet row. The
--   Sheet write is best-effort and was previously deferred until after the
--   status had already flipped to 'promoted' (especially in the batched
--   multi-promote path), so a hire could show as Promoted while never actually
--   reaching the source-of-truth Sheet — and then quietly drop out on the next
--   Sheet -> Supabase sync.
--
--   The guardrail: if any step of a promote fails (master insert/lookup, status
--   write, or the Sheet append), the row lands in 'failed_to_promote' instead of
--   'promoted'. The HR dashboard renders that as a red pill and lets the user
--   retry; retry is idempotent (the existing master row is reused).
--
--   The inline CHECK on the original table only permits
--   ('pending_work_email','ready','promoted','cancelled','no_show'); any UPDATE
--   setting 'failed_to_promote' fails at the DB until this runs. The constraint
--   is auto-named hr_pending_employees_status_check.
--
-- Idempotent: drops the existing constraint (if present) and re-adds it with the
-- widened value set. Safe to re-run.

ALTER TABLE public.hr_pending_employees
  DROP CONSTRAINT IF EXISTS hr_pending_employees_status_check;

ALTER TABLE public.hr_pending_employees
  ADD CONSTRAINT hr_pending_employees_status_check
  CHECK (status IN (
    'pending_work_email',
    'ready',
    'promoted',
    'cancelled',
    'no_show',
    'failed_to_promote'
  ));

-- Verify
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.hr_pending_employees'::regclass
  AND conname = 'hr_pending_employees_status_check';
