# Gift delivery — naming someone else to receive it

**Approved brief:** in-session 2026-09-18, session `86ceb4f8`. Kane's ask:

> *"There are some employees that have their spouses receive their gifts for them so lets
> please add something like an option for the recipient to let them know that another person
> is receiving the gift for them"*

Kane's rulings on the three blocking questions:

- **Q1 — which number does the courier call?** *"The Employees as they will contact their
  spouse."* ⇒ **`active_contact_number` keeps its exact current meaning and the export's
  `Contact Number` column is UNTOUCHED.** The recipient's number is collected as a separate,
  additional field and **never substitutes**. The failure flagged in the brief's RISK line —
  a ship list silently calling the wrong person — is closed by the ruling, not by a guard,
  and a test pins it so a later "helpful" fallback cannot reopen it.
- **Q2 — how much structure?** *"Yeah name relationship and contact info"* ⇒ three fields.
- **Q3 — does it carry to the next gift?** *"Yes"* ⇒ it joins the `/api/gift-address/owed`
  prefill like every other field (option **a**). In-session judgment call inside that answer,
  stated to Kane: the carried-over recipient renders as a **visible named block with a Remove
  control**, not a quietly pre-populated input, so a two-year-old arrangement cannot ride
  along unnoticed.

**Precedent:** `src/components/payroll-clerk/PaidRecordsPanel.tsx:172` — `showHolder` prints
the bank account holder **only when it differs** from the recipient. Same product question (a
third party receives what is owed to you), same display rule, not reinvented ·
`references/sql/alter/add_apparel_size_to_shipping_details.sql` — the last column added to
this exact table, for the same reason · `APPAREL_SIZES` in
`src/lib/gift-tracker/milestone-copy.ts` — a closed list whose unknown value is **refused,
never coerced to blank** (`app/api/gift-address/save/route.ts:78`); `relationship` copies it.

**Two things established in scope that shape the build:**

1. The Notes placeholder has invited *"alternative recipient"* as free text since the form
   shipped (`GiftShippingCard.tsx:891`). That prose exists in live rows. **It is never parsed
   and never backfilled** — guessing intent out of free text redirects real parcels on a
   regex.
2. Structured recipient fields are a *shipping* fact, not a *fulfilment* fact.
   `employee_gift_receipts` stays out entirely: **submitting is still not receiving**
   (`docs/features/gift-address-external-link.md:92`), and nothing here records who signed
   for a parcel.

## Task 1 — SQL

- [x] `references/sql/migrate/2026-09-18_gift_alternate_recipient.sql`
  - `recipient_name`, `recipient_relationship`, `recipient_contact` — all
    `TEXT NOT NULL DEFAULT ''`, so every existing row reads "the employee receives it" with
    no backfill and no nullable third state.
  - CHECK `egsd_recipient_all_or_nothing` — either all three are blank, or **name AND
    relationship are both non-blank**. Kills the partial record: a relationship or a phone
    number with nobody's name attached is a parcel the courier cannot hand over.
  - CHECK `egsd_recipient_relationship_known` — blank or one of the closed list. The
    apparel-size rule applied to a second field.
  - CHECK `egsd_recipient_lengths` — 120 / 60, matching the route's limits so a direct DB
    write cannot store what the app would refuse.
  - `btrim(...)` in every CHECK so a whitespace-only name cannot satisfy "non-blank".
  - **No `BEGIN` / `COMMIT`** — the runner owns the transaction
    (`gift-tracker-receipts.md` § Deploy order, found the hard way 2026-09-11).
  - The existing `employee_gift_shipping_normalize` trigger is **not touched**. App code
    trims; the CHECKs make a whitespace-only value unrepresentable either way.
- [x] `scripts/apply-gift-alternate-recipient-migration.mts` — `--dry` (default) / `--apply` /
  `--verify`, modelled line-for-line on `scripts/apply-gift-address-migration.mts`: rehearse
  inside a transaction, verify the columns and CHECKs landed, then prove each CHECK **bites**
  with a positive control first (a suite that cannot accept a good row is indistinguishable
  from one where the constraints do nothing).

## Task 2 — pure module + tests

- [x] `src/lib/gift-tracker/alternate-recipient.ts` — no imports, no `server-only`, so both
  routes, both forms, the tracker and the export read ONE implementation.
  - `GIFT_RECIPIENT_RELATIONSHIPS` — the closed list.
  - `normalizeAlternateRecipient` — trims; a blank name **drops** the relationship and
    contact rather than storing an orphan pair.
  - `hasAlternateRecipient` — THE one predicate, from a trimmed non-blank name. Due-ness has
    exactly one implementation (`gift-tracker-receipts.md:87`); so does this.
  - `validateAlternateRecipient` — refuses an unknown relationship, a name with no
    relationship, and over-length. Returns the normalized triple on success.
  - `describeAlternateRecipient` — `"Maria Reroma (Spouse)"`, one spelling for the export and
    both UIs.
- [x] `src/lib/gift-tracker/alternate-recipient.test.ts` (`node:test`)

## Task 3 — data layer

- [x] `src/lib/supabase/employee-gift-shipping.ts` — the three columns on
  `EmployeeGiftShippingRow`, `SELECT_COLS`, `UpsertShippingInput`, `upsertShippingDetail` and
  `editShippingDetailFields`. The approved-row refusal already sits in `upsertShippingDetail`
  and the staff edit already avoids `status`, so the new fields inherit the lock rather than
  opening a second write path.

## Task 4 — routes

- [x] `app/api/employee-gift-shipping/route.ts` — validate through the module; 400 on a
  refusal. Audit details gain `has_alternate_recipient: boolean` — **a boolean, never the
  name or the number**: the address is kept out of the trail because the audit log is read by
  more people than the shipping list is, and a third party's details deserve that more, not
  less.
- [x] `app/api/gift-address/save/route.ts` — same validation, written across every pending
  milestone in the same pass as the address.
- [x] `app/api/gift-address/owed/route.ts` — the three fields join `prefill` (Q3).

## Task 5 — export

- [x] `src/lib/gift-tracker/shipping-export.ts`
  - CSV / XLSX sheet 1: `Alternate Recipient`, `Recipient Relationship`, `Recipient Contact`,
    placed **after** `Contact Number`, which does not change.
  - XLSX sheet 2 (`All submissions`): the same three.
  - PDF: one new column, `Received By` — the printed ship list needs *who to hand it to*
    more than it needs the rest. Width reclaimed from Name / Work Email / Shipping Address;
    `wrapText` wraps rather than truncates, so a narrow column loses nothing.
  - Summary band + `summaryLine`: `Alt recipient` — how many parcels go to somebody else.
- [x] `src/lib/gift-tracker/shipping-export.test.ts`
  - **`Contact Number` prints the employee's number even when a recipient contact is set.**
    This is Q1 as an executable guard.
  - a blank recipient reads as `-`, never as an empty-string "someone".
  - off-roster submitters carry theirs too.

## Task 6 — UI

- [x] `src/components/orphanage/GiftTracker.tsx` — both payload blocks gain a
  **`Received by:`** line rendered **only when one is named** (the `showHolder` idiom); the
  search haystack gains the name; the staff edit draft gains the three fields.
- [x] `src/components/employee/GiftShippingCard.tsx` — a *Someone else is receiving this*
  toggle opening name + relationship chips + contact.
- [x] `app/update-gift-address/page.tsx` — the same block, reading the same module, with the
  carried-over recipient shown as a named block + Remove (Q3).

## Task 7 — verify

- [x] `node --test` on the two touched test files, then the full suite.
- [x] `npx tsc --noEmit`.
- [x] `next build` **NOT run** — a `next dev` was live on :3000 and they share `.next/`.

## Task 8 — document (same commit)

- [x] `docs/features/gift-alternate-recipient.md`
- [x] `docs/features/INDEX.md` row 39 — doc + `[[gift-alternate-recipient]]` wikilink + the
  invariant in the Key-invariant cell.
- [x] memory `gift-alternate-recipient` (replacing the pending-brief entry) + `MEMORY.md`.
- [x] Open item 111 updated from *awaiting Kane* to shipped, with the migration **PENDING**.

**Outcome:** 33 new tests, all passing (suite 3,856/3,859 — the 3 failures pre-date this work,
see [[main-has-three-failing-tests-2026-09-18]]). `npx tsc --noEmit` clean.
