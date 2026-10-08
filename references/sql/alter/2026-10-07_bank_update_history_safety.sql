-- ============================================================================
-- [PAYOUT-SAFETY] bank_update_history.safety  (2026-10-07)
--
-- Kane, 2026-10-07: employees who change their bank details must be warned
-- first (card numbers instead of account numbers, closed accounts, a spouse's or
-- anyone else's account), and a wrong account they enter must be on record as
-- THEIR error, not an HRIS problem. Both self-service save routes
-- (/api/bank-update/save and /api/update-employee-ids, self edits only) now
-- require the employee to acknowledge a versioned notice, plus a separate
-- confirmation when the new account looks like a card number or its holder is
-- not them. What they attested is written here, beside the masked before->after.
--
-- `safety` holds a PayoutChangeAttestation (src/lib/banking/payout-change-safety.ts):
--   { notice_version, attested_at, destination_changed, flags[],
--     holder_confirmed, card_confirmed,
--     previous_account: { paid_count, problem_count, last_paid_on } | null }
-- Flags and counts ONLY. Never an account number, wallet address or name
-- (update-bank-info.md rule 22: no trail holds a full value).
--
-- NULL for staff edits (People tab, Payroll Wizard Readiness), for every row
-- before 2026-10-07, and for rows written while this column was missing (the
-- writer retries without it, and the attestation is still on the audit_log row).
--
-- This table is the NON-clearable copy: audit_log can be truncated by any admin
-- (DELETE /api/audit-log), which is why the attestation lives here too.
--
-- Additive and idempotent: one nullable column, no default, no row touched.
-- Apply with: node --import tsx scripts/apply-bank-update-history-safety-migration.mts --apply
-- No BEGIN/COMMIT here: the apply script owns the transaction, and its dry run
-- wraps this file in one it always rolls back (a COMMIT in here would defeat that).
-- ============================================================================

ALTER TABLE public.bank_update_history
  ADD COLUMN IF NOT EXISTS safety jsonb;

COMMENT ON COLUMN public.bank_update_history.safety IS
  '[PAYOUT-SAFETY] What the employee attested on a self-service payout change: notice version, flags (card_shaped_account, holder_not_employee), confirmations, and the paid/problem counts of the account being left. Flags and counts only, never a value. NULL for staff edits and rows before 2026-10-07.';

-- PostgREST caches the schema; without a reload it keeps rejecting the new
-- column with PGRST204 after the DDL has succeeded. Delivered at COMMIT, so a
-- rolled-back rehearsal sends nothing.
NOTIFY pgrst, 'reload schema';

-- Verify:
--   SELECT data_type, is_nullable FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='bank_update_history' AND column_name='safety';
--   -- expect: jsonb | YES
