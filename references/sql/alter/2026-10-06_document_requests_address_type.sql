-- Proof of Residential Address letter (2026-10-06, audit item 375).
--
-- Accounting → Documents → Signing Queue → "Proof of Address" issues a signed letter that rides
-- the ordinary document_requests pipeline, so the signed copy reaches the worker's
-- Profile → Request Documents with the documents.signed notification (the Generate COE pattern).
-- The only schema change is widening the document_type CHECK to admit 'address'.
--
-- The employee request form and POST /api/employee/documents never accept 'address'
-- (EMPLOYEE_REQUEST_TYPES in src/lib/documents/types.ts): Carla's rule is that only Accounting
-- creates this letter. That is enforced in the app, not here, because the table holds both.
--
-- Run with: node --import tsx scripts/apply-address-letter-migration.mts --apply
-- Re-runnable: the constraint is dropped by name and re-added. No row is modified.

ALTER TABLE public.document_requests
  DROP CONSTRAINT IF EXISTS document_requests_document_type_check;

ALTER TABLE public.document_requests
  ADD CONSTRAINT document_requests_document_type_check
  CHECK (document_type IN ('paystub', 'coe', 'award', 'other', 'address'));
