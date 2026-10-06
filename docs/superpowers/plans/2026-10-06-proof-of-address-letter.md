# Proof of Residential Address letter — Accounting-only generated document

**Brief:** in-session 2026-10-06 (session `1b35d87f`, audit item 375). Aliviah made one by hand for a
worker's bank; Carla's rule is that only Accounting creates it. Kane: *"Go build now"*. Built under
the 2026-09-26 blueprint rule: recommendations taken (CHOSEN 1–7), no NEEDS.

**Stack:** pdf-lib renderer beside `coe-document.ts`, the `document_requests` pipeline, two
Accounting routes gated like Generate COE, one dialog in the Signing Queue toolbar,
`node --import tsx --test`. One CHECK-constraint migration, run by Kane.

**Precedent:** Signing Queue → Generate COE (`GenerateCoeDialog.tsx`,
`app/api/accounting/documents/coe/*`, `coe-admin.ts`, `coe-document.ts`). Rep-filled blanks follow
Termination Letters #35 (`termination-docs.md:310`).

## Task 1 — data layer

- [x] `references/sql/alter/2026-10-06_document_requests_address_type.sql`: drop and re-add
  `document_requests_document_type_check` with `'address'`.
- [x] `scripts/apply-address-letter-migration.mts`: dry run by default (transaction rolled back),
  `--apply` commits after the checks pass, `--verify` checks only. Controls inside a SAVEPOINT.

## Task 2 — types

- [x] `types.ts`: `'address'` in `DocumentRequestType` / `DOCUMENT_REQUEST_TYPES` / labels /
  `SYSTEM_GENERATED_TYPES`. New `EMPLOYEE_REQUEST_TYPES` (the four old ones) +
  `isEmployeeRequestType`. `AddressLetterPreviewFacts` for the client.

## Task 3 — pure rules + tests

- [x] `address-letter.ts`: `pickLetterAddress(roster, submissions)` (roster first, newest
  submission with a street second, one source per address, country from submissions only),
  `applyLetterFills(facts, fills)` (blank fields only; values validated; every field required
  after the merge), `addressLetterSummaryLabel`.
- [x] `address-letter.test.ts`.

## Task 4 — server facts

- [x] `address-letter-facts.ts`: `resolveAddressLetterFacts(email)` — master record (name via
  `coeWorkerName`, start date via `formatCoeStartDate`, team via `formatDeptLabel`, employee id),
  submissions by the master row's PERSONAL email only over `email` / `invite_personal_email` (one
  `.ilike` per column, escaped, limit 50). Never by work email: recycled addresses (measured: the
  one work-email-only match was a different person). Refusals: `no_master`, `bad_name`,
  `no_start_date`, `no_department`.

## Task 5 — renderer + tests

- [x] `address-letter-document.ts`: one page, Aliviah's template; draft = watermark + UNSIGNED box.
- [x] `address-letter-document.test.ts`: draft + signed one page at full signature height; long
  values wrap and stay on one page; the `onLayout` slack floor.

## Task 6 — pipeline

- [x] `requests.ts`: `createSignedAddressLetter({ facts, address, typed, actorEmail })` renders draft + signed
  (NO certification page — its "submitted by the employee" is false here), uploads both, inserts the row as `signed`, maps the CHECK violation
  to `migration_pending`, cleans up uploads on failure, audits both events, notifies the employee.
  `signDocumentRequest` refuses an `address` row.
- [x] `coe-admin.ts`: `decideCoeActiveGate` takes optional wording; the COE text is unchanged.

## Task 7 — routes

- [x] `GET /api/accounting/documents/address/preview?email=` (edit): gate → facts.
- [x] `POST /api/accounting/documents/address` (edit): gate → 412 signature → facts → fills → create.

## Task 8 — employee side stays closed

- [x] Employee POST validates `isEmployeeRequestType`; the form lists `EMPLOYEE_REQUEST_TYPES`.
- [x] Source-scan test: neither surface can offer `address`.

## Task 9 — UI

- [x] `GenerateAddressLetterDialog.tsx`: search (reuses `coe/search`), facts card with source labels,
  inputs for blank fields only, country picker, signature block, Issue & sign.
- [x] Toolbar button beside Generate COE (`canEdit`).

## Task 10 — verify + document

- [x] Targeted tests, `npm test`, `tsc --noEmit`.
- [x] Feature doc, documents-tab pointer, INDEX row, memory, Open items 375, one commit.
