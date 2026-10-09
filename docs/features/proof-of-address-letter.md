# Proof of Residential Address — an Accounting-only signed letter

Accounting → Documents → Signing Queue → **Proof of Address** issues a signed one-page letter. It states
that a worker is contracted with Simple and has given us the residential address printed in its
box. A bank asked a worker for one. Aliviah made it by hand (2026-10-06), and Carla ruled that **only
Accounting creates it**. One click renders, signs and delivers the letter to the worker's
Profile → Request Documents with the `documents.signed` notification. Built 2026-10-06, session
`1b35d87f`, audit item 375, plan `docs/superpowers/plans/2026-10-06-proof-of-address-letter.md`.

The host tab, its signature and its queue are [documents-tab.md](documents-tab.md). The closest
sibling is § *Accounting can generate + sign it directly* (Generate COE) in that doc.

## Key files

| Piece | File |
| --- | --- |
| Pure rules: address source, rep fills, summary label, gate wording | `src/lib/documents/address-letter.ts` (+ `.test.ts`) |
| Server facts: master record + onboarding forms | `src/lib/documents/address-letter-facts.ts` |
| The PDF (draft + signed) | `src/lib/documents/address-letter-document.ts` (+ `.test.ts`) |
| Issue + sign + store + audit + notify | `createSignedAddressLetter` in `src/lib/documents/requests.ts` |
| Who may create it (pinned) | `src/lib/documents/address-letter-access.test.ts` |
| Preview route (edit) | `app/api/accounting/documents/address/preview/route.ts` |
| Issue route (edit) | `app/api/accounting/documents/address/route.ts` |
| Dialog | `src/components/accounting/GenerateAddressLetterDialog.tsx` |
| Type, labels, `EMPLOYEE_REQUEST_TYPES` | `src/lib/documents/types.ts` |
| Migration | `references/sql/alter/2026-10-06_document_requests_address_type.sql` · `scripts/apply-address-letter-migration.mts` |

## 1. Only Accounting creates it

`document_type = 'address'` lives in `document_requests` beside the employee-filed types, so the
rule is enforced in the app. **The employee form and `POST /api/employee/documents` read
`EMPLOYEE_REQUEST_TYPES`, never `DOCUMENT_REQUEST_TYPES`.** Before this build, the form mapped
`Object.entries(DOCUMENT_TYPE_LABELS)`, which would have offered the letter to every employee the
moment its label existed. `address-letter-access.test.ts` source-scans both surfaces.

Both Accounting routes use `requireFeatureEdit('accounting', 'documents')`, the Generate COE gate.
No new feature key exists. A new key defaults to `hidden` and would make the tab vanish.

The worker still **receives** the letter: the row is theirs (`employee_email` = work email), so it
lists in their Profile → Request Documents. They can download it there and delete their copy, like
any decided row.

## 2. Active roster people only, failing closed

The letter says the worker "**is currently contracted** with Simple", so it takes the COE's active
gate (`decideCoeActiveGate`, `coe-admin.ts`) under its own wording (`ADDRESS_LETTER_GATE_WORDING`).
The COE's text is unchanged byte for byte, and a test pins that. The gate runs at preview and again
at issue, against the live status map. A status-map read error is a 500, never "not on the list".
The picker reuses `GET /api/accounting/documents/coe/search`: same population, and the work email
identifies.

## 3. Where the address comes from: one source, never a blend

`pickLetterAddress`:

1. **The roster** (`global_master_list`). The address line is `full_address` when present, else
   `street`. This is the ID card's composition (`employee-id-card.md:99`): `full_address` carries
   the barangay, and `street` often does not. City, province and postal code come from the same row.
2. **Else the newest onboarding submission with a street**: the address the contractor typed on
   their own paperwork. Its city, its province (else state) and its postal code come from that form.
3. **Else nothing.** Every field is a blank for the rep (§4).

Rules that look like bugs and are not:

- **`employee_ids.full_address` is never a source.** That is the payout address the employee edits
  on Profile → Payment, and `employee-id-card.md:93-95` forbids exactly this fallback on an identity
  document.
- **A roster address with no postal code does not borrow one from the onboarding form.** A street
  from one record and a postal code from another describes no real house. The gap is a blank the
  rep fills.
- **The country comes only from a submission's hire-selected `country`.** It never comes from
  `invite_country` (`cop-country-payees.md:57-64`) and is never inferred from the address. The
  roster has no country column, so a roster-sourced address usually leaves the country blank, and
  the rep picks it from the onboarding list (Philippines / United States / Colombia).
- **Forms are matched by the master row's PERSONAL email only, never a work email.** Work addresses
  have been re-issued to new hires, so a form filed under a work email can belong to the previous
  holder. Measured 2026-10-06: 457 of the 458 form-sourced people match by personal email. The one
  that matched only by work email carried a different personal email, which is exactly the
  wrong-person case.
- The roster's free-text `"Location"` cell is **not** used. Much of it is city-level
  ("Parañaque City, Metro Manila") or just "US", and a bank letter needs a street.

**Coverage, measured 2026-10-06 over 1,258 active people:** 254 have a roster address, 458 more
have one on an onboarding form, and about 546 have neither. For those 546 the rep types it.

## 4. The rep fills only what the records leave blank

Copied from Termination Letters #35 (`termination-docs.md:310`). `applyLetterFills` refuses the
request when any of these is true:

- the request sends any key for a field that is **on file**;
- the request sends an unknown key;
- a value is not text, or contains a control character;
- a value is over its length cap (street 200, city/province 120, postal 20);
- the country is not on the onboarding list;
- the postal code contains anything but letters, digits, spaces and hyphens;
- **any** field is still blank after the merge.

The route re-resolves the facts itself and never trusts the preview.

An on-file value **cannot be overridden here.** If the worker has moved, HR corrects the roster.
This dialog never writes back to the roster or the onboarding form.

The audit records which fields came from records and which the rep typed (`address_source`,
`country_source`, `typed_by_accounting`). The PDF never says.

## 5. Issued already signed: there is never a pending row

`createSignedAddressLetter` renders the watermarked draft (stored as `original.pdf`, which the
worker can download) and the signed letter (`signed.pdf`). It uploads both and inserts the row
**already `signed`**. If any step fails, the uploads are removed.

The reason is the rep-typed values. They are stored nowhere a later re-render could read them, so
the COE's "re-render at signing" cannot apply. A pending row would also let the ordinary Approve
button stamp the watermarked draft. **`signDocumentRequest` refuses an `address` row**, and the
guard runs before the signature read, pinned by a test.

The route's refusal order is:

1. active gate;
2. **signature 412, before any address is read or rendered**;
3. facts;
4. fills (400);
5. create.

A CHECK violation on `document_type` returns 503 `migration_pending` with the uploads removed.

Several letters per person are allowed, because each is dated. There is no "one pending" rule
because nothing pends.

## 6. The letter

It follows Aliviah's template: letterhead, a tracked `PROOF OF RESIDENTIAL ADDRESS` title, the name
with Employee ID · team · work email under it, then "To Whom It May Concern" and the paragraph. A
grey box holds FULL LEGAL NAME / RESIDENTIAL ADDRESS / CITY / STATE / PROVINCE / POSTAL / ZIP CODE /
COUNTRY / DATE ISSUED, and below it "Signed," and the signature. The footer carries the Reference ID
and "Confidential document — Simple.biz © <year>".

- **One wording change from the template:** it says the address "listed **below**", not "above".
  The template's own box sits below the paragraph.
- The name is `coeWorkerName` (legal name, nickname dropped; malformed rows refuse `bad_name`). The
  date is `formatCoeStartDate`, and the team goes through `formatDeptLabel` (no raw `hsl:*`). These
  are the COE's own composers, so the two documents cannot name a person differently. Missing name,
  start date or team **refuses** (422). An address gap is never a refusal (§4).
- The signature block reads the signer's own saved name, then **"Accounting Team · <signer email> ·
  <date>"**. That is the template's wording: the team, not the signer's personal title.
  `signed_by_title` still records the title on the row.
- **No certification page is appended.** The shared page (`sign-pdf.ts`) says the document "was
  submitted by the employee named below", which is false for a letter Accounting issues, and it
  would print the city as a "PERIOD". The letter verifies itself through the Reference ID in its
  footer, the issue date in the box and on the signature line, and the signer's block. A test pins
  that `createSignedAddressLetter` never calls `stampSignedDocument`. (Generate COE carries the same
  false sentence; Open items 376.)
- Dates are Manila (`October 6, 2026`). One page is pinned for the draft and the signed copy at
  **full signature height**, and for a worst case (long name, team and email, a three-line address)
  with a **≥ 40pt slack floor**. Recover space from the whitespace gaps, never from the box or the
  signature block.
- The drawing primitives are **copied** from `coe-document.ts`, not shared. The COE's one-page layout
  is pinned by its own tests, and refactoring it to serve a second document was not worth the risk.

Rendered 2026-10-06 through pdf.js (scratch only): page geometry matches the template. Headless
Chrome here does not paint canvas text, so the text was checked through pdf.js's text layer
(positions real, face substituted).

## Deploy notes

- **Migration: APPLIED** (measured 2026-10-07 by session `3bc62721`: `--verify` passes; Open item 375, `630e50b6`).
  Re-check with `--verify`. How it was run: `node --import tsx scripts/apply-address-letter-migration.mts`
  (a dry run, rolled back), then the same with `--apply`. It widens
  `document_requests_document_type_check` to admit `'address'`. Every control insert is rolled back.
  Until it runs, Issue & sign answers **503 "needs a one-time database update"** and leaves nothing
  behind. The code is safe to deploy before or after it.
- No env vars. No n8n. No new feature key: whoever holds Accounting → Documents **edit** sees the
  button.
- **NOT clicked through signed in.** The facts resolver was run read-only against live data for one
  person of each source (roster: country blank; onboarding: complete; none: all four blank).
