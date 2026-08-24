-- Payout-wallet BRAND STAMP on the onboarding paperwork.
--
-- Hurupay rebranded to Kolan (2026-08-24). Every live screen now reads "Kolan",
-- but a paperwork record is a historical document: a hire who signed in June
-- agreed to receive pay via "Hurupay", and HR's copy of that record has to keep
-- saying so. This column records which brand the hire actually saw.
--
-- THE ROUTING VALUE IS UNCHANGED, DELIBERATELY.
--   `payment_method` stays 'hurupay' — its CHECK constraint, the mirrored
--   `employee_ids.bank_preferred` literal, and isWiresPreferred() in
--   src/lib/employee-payment-processors.ts all key on that exact string. A
--   value rename would make every Hurupay/Kolan payee read as WIRES and lock
--   them out of the wallet rail. See docs/features/bank-preferred-routing.md §4.
--   This column carries the DISPLAY BRAND only and drives no routing.
--
-- NULL = pre-rebrand record = renders "Hurupay".
-- 'kolan' = the hire saw the Kolan branding.
--
-- NO CHECK CONSTRAINT, on purpose. A rejected write here must never block a
-- hire's paperwork from landing (cf. the kpi.scored CHECK that silently ate
-- inserts for three days). The narrow union type lives in TypeScript instead,
-- and the writer strips this column and retries if the migration has not run
-- (OPTIONAL_COLUMN_FAMILIES in src/lib/supabase/hr-onboarding-submissions.ts).
--
-- The backfill stamps every existing row 'hurupay' explicitly, so "never
-- stamped" and "Hurupay-era" stop being the same state going forward.
--
-- APPLY THIS BEFORE DEPLOYING the Kolan label change. A submission that lands
-- in the gap between deploy and apply shows Kolan to the hire but is stamped
-- 'hurupay' by the backfill — cosmetic, and correctable with a one-row UPDATE.
--
-- Idempotent (IF NOT EXISTS) and transactional — safe to re-run.
-- Apply with: node scripts/apply-payout-brand-column.mjs

BEGIN;

ALTER TABLE public.hr_onboarding_submissions
  ADD COLUMN IF NOT EXISTS payout_brand TEXT;

-- Every row that exists at migration time predates the rebrand.
UPDATE public.hr_onboarding_submissions
   SET payout_brand = 'hurupay'
 WHERE payout_brand IS NULL;

COMMENT ON COLUMN public.hr_onboarding_submissions.payout_brand IS
  'DISPLAY brand of the wallet rail as shown to the hire: ''hurupay'' (pre-2026-08-24) or ''kolan''. Label only — routing keys on payment_method, which stays ''hurupay'' for both. NULL is treated as ''hurupay''.';

COMMIT;

-- Verify:
--   SELECT payout_brand, count(*)
--     FROM public.hr_onboarding_submissions
--    GROUP BY payout_brand
--    ORDER BY payout_brand;
