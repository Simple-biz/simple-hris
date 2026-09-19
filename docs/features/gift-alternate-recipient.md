# Gift alternate recipient — naming somebody else to receive a tenure gift

Three columns on `employee_gift_shipping_details` and a block on both gift forms
(the Employee dashboard card and the public `/update-gift-address` page) where an
employee names the person who will actually take delivery — in practice a spouse
accepting the parcel while they are at work. The Gift Tracker and all three
export formats carry it through to whoever ships the box.

Built 2026-09-18 on Kane's approval of the posted blueprint, session `86ceb4f8`.

> *"There are some employees that have their spouses receive their gifts for
> them."* — Kane, 2026-09-18

Before this, the only place to say so was the free-text **Notes** box — whose
placeholder has read *"Landmark, alternative recipient, gate code…"* since the
form shipped. The fact existed in prose and nothing could act on it.

## Key files

| Piece | File |
| --- | --- |
| Migration | `references/sql/migrate/2026-09-18_gift_alternate_recipient.sql` |
| Migration runner | `scripts/apply-gift-alternate-recipient-migration.mts` |
| The one implementation | `src/lib/gift-tracker/alternate-recipient.ts` + `.test.ts` |
| Data access | `src/lib/supabase/employee-gift-shipping.ts` |
| Employee write | `app/api/employee-gift-shipping/route.ts` |
| Staff edit | `app/api/employee-gift-shipping/[id]/route.ts` |
| Public write / prefill | `app/api/gift-address/{save,owed}/route.ts` |
| Employee dashboard form | `src/components/employee/GiftShippingCard.tsx` |
| Public form | `app/update-gift-address/page.tsx` |
| Gift Tracker display + staff edit | `src/components/orphanage/GiftTracker.tsx` |
| Export columns | `src/lib/gift-tracker/shipping-export.ts` + `.test.ts` |

Closest cousin, and the thing the display rule was copied from rather than
invented: **`RecordRecipientBank`** in
`src/components/payroll-clerk/PaidRecordsPanel.tsx:172`, where `showHolder`
prints the bank account holder **only when it differs** from the payee. Same
product question — a third party receives what is owed to you — and the same
answer: say it only when it is true.

## The courier still calls the employee

**This is the rule the next person will break, and it is Kane's, not an
inference.** Asked which number the courier should call when a spouse is
receiving the parcel:

> *"The Employees as they will contact their spouse."*

So:

| Column | Means | Changes when a recipient is named? |
| --- | --- | --- |
| `active_contact_number` | the number to call on delivery | **No. Never.** |
| `recipient_contact` | the recipient's own number, a fallback | it *is* the new field |

The export's **`Contact Number` column is untouched** and still prints the
employee's; the three recipient columns sit **beside** it. `recipient_contact` is
**optional** for the same reason — requiring a fallback would block a legitimate
submission from somebody who does not have their spouse's number to hand.

The tempting edit is to make `contactNumber` fall back to the recipient's number
when one exists. That would point the entire shipping list at the wrong person
and nothing in the file would say so. `shipping-export.test.ts` pins it
(*"CONTACT NUMBER STAYS THE EMPLOYEE'S even when a spouse receives the gift"*),
and the column carries a doc comment saying why.

## A blank name is not a person

`hasAlternateRecipient` — one predicate, in `alternate-recipient.ts`, read by
both forms, all four routes, the Gift Tracker and every export format. It is true
**iff a trimmed, non-blank `recipient_name` exists**.

The name is load-bearing because it is the only field a courier can act on: a
relationship names nobody, and a phone number is somebody to call, not somebody
to hand a box to. So the three columns move as a **set**:

- all three blank → the employee receives it themself;
- a name **and** a relationship → somebody else does, contact optional;
- anything else is **unrepresentable** — `egsd_recipient_all_or_nothing` refuses
  it at the database, `validateAlternateRecipient` refuses it at every write, and
  `normalizeAlternateRecipient` drops an orphan pair rather than storing it.

Every CHECK uses `btrim(...)`: without it `'   '` satisfies `<> ''` and every
surface downstream renders a handover to nobody.

Due-ness has exactly one implementation
([gift-tracker-receipts.md](gift-tracker-receipts.md)); so does this, and for the
same reason. A second spelling of *"does this parcel go to someone else"* is how
the screen and the shipping list end up disagreeing about who is at the door.

## The relationship is a closed list, and an unknown value is refused

`GIFT_RECIPIENT_RELATIONSHIPS` — Spouse · Partner · Parent · Sibling · Child ·
Relative · Housemate · Friend · Colleague · Other — mirrored by
`egsd_recipient_relationship_known`. Case-sensitive: the list is the list.

An unrecognised value is **refused, never coerced to blank**, which is the trade
the apparel size already makes one field over
([gift-address-external-link.md](gift-address-external-link.md) § *The milestone
list is recomputed server-side on save*). A silently dropped value means somebody
hands the parcel to the wrong person and never finds out why.

`normalizeAlternateRecipient` **does not truncate** an over-long name either. The
validator refuses it and the `egsd_recipient_lengths` CHECK refuses it, at the
same 120 / 60 limits, so the app and the database refuse the same thing. A
normaliser that quietly sliced would let a write path that skipped validation
store a shortened name that nobody could ever recover.

## Nothing is backfilled, and the Notes are never parsed

Live rows hold prose naming spouses in `notes` — the placeholder invited it. That
text is **not parsed, not migrated, and not read by any of this**. Guessing
intent out of free text redirects real parcels on a regex.

The columns are `TEXT NOT NULL DEFAULT ''`, so every pre-existing row reads *"the
employee receives it"* without being rewritten, and the migration contains no
`UPDATE` at all. A nullable column was rejected for the reason
`employee_gift_receipts.received` is `BOOLEAN NOT NULL`: it would make "nobody
said" representable both as `NULL` and as `''`, and the two would drift.

## Submitting is still not receiving

This writes `employee_gift_shipping_details` and nothing else. **Nothing here
records who actually signed for a parcel** — that is fulfilment, it lives in
`employee_gift_receipts`, and naming a spouse on a form is not evidence a gift
arrived. The ledger is untouched by this feature, as is the milestone gate, which
still opens on pure tenure arithmetic
([gift-tracker-receipts.md](gift-tracker-receipts.md) § *What is still open*).

## The arrangement carries to the next gift — visibly

Kane's Q3 ruling was **yes**: the three fields join the `/api/gift-address/owed`
prefill like the address, the contact and the size, so a returning person
confirms rather than retypes.

What keeps that honest is the **presentation**, not the data. On the public page
a carried-over recipient renders as a named amber block — *"Still going to
someone else · Maria Dela Cruz (Spouse)"* — with a **Remove** button, never as a
quietly pre-populated text input. An arrangement made two years ago must be
looked at, not discovered on the doorstep. The employee dashboard card derives
its checkbox from the loaded row for the same reason.

**Unticking the box clears the fields**, on both forms. A hidden-but-still-sent
field is how somebody removes their spouse from the delivery and it silently
stays.

## The audit trail records that, not who

`employee_gift_shipping.submitted` and `gift_address.saved` gain
`has_alternate_recipient: boolean`. **A boolean — never the name, never the
number.**

The address is already kept out of the trail because the audit log is read by
more people than the shipping list is. A third party's details deserve that more,
not less: the named person does not work here and never agreed to appear in our
audit log. *That* a redirection was arranged is auditable; *who they are* is not.

## Where it shows in the Gift Tracker

A **`Received by:`** line in both submission payload blocks, rendered **only when
somebody else is receiving it**. A *"Received by: <the employee>"* line on every
row would be noise, and noise is what gets skimmed past on the one line that
changes what happens at the door.

The name joins the **search haystack** — *"who was the parcel for Maria?"* is a
question the shipping team actually asks. The staff edit dialog can correct all
three, and they move as a set: clearing the name clears the relationship and the
number with it, so a manager can never leave a spouse's name attached to a
stranger's phone number. An approved row stays locked; the new fields ride the
existing refusal in `upsertShippingDetail` rather than opening a second write
path.

## Export columns

CSV and XLSX sheet 1, immediately after `Contact Number`:
**`Alternate Recipient`** · **`Recipient Relationship`** · **`Recipient
Contact`**. The XLSX `All submissions` sheet carries the same three. A blank
prints `-`, never an empty cell — a dash is an answer (*this person receives
their own gift*), a blank is a missing value.

The **PDF** gains one column, **`Received By`**, printed as `Maria Dela Cruz
(Spouse)` through `describeAlternateRecipient` — one spelling, shared with the
Gift Tracker and both forms. Width is reclaimed from Name / Work Email / Shipping
Address; `wrapText` wraps rather than truncates, so narrower columns cost lines on
the page, never characters out of a name. The employee's contact number remains
absent from the PDF, as it always has been — this column does not change who the
courier calls.

The summary band and the provenance line gain **`Alt recipient`**: how many
parcels go to somebody other than the employee.

Off-roster submitters keep their recipient too. They are the likeliest people to
be mis-shipped ([gift-tracker-shipping-export.md](gift-tracker-shipping-export.md)
§ *Off-roster submitters are appended, never dropped*), so dropping the one field
that says who is actually at the door would be exactly backwards.

## Deploy notes

**Run in this order.**

1. `node --import tsx scripts/apply-gift-alternate-recipient-migration.mts` —
   rehearses inside a transaction and rolls back. Verifies the three columns,
   their comments, the three CHECKs and the partial index, then proves each CHECK
   **bites** behind three positive controls.
2. The same with `--apply`. **PENDING — Kane runs this.**
3. Deploy the code.

**Run the migration BEFORE deploying.** The columns are in `SELECT_COLS`, so with
them absent *every* gift-shipping read fails — not just the new field.

**The migration SQL carries no `BEGIN`/`COMMIT`.** The apply script owns the
transaction; a `COMMIT` inside the file ends it from within, so the rehearsal
commits to production and the script's own `ROLLBACK` has nothing to undo. That
happened on 2026-09-11 with the gift-receipts migration. Every sibling under
`references/sql/migrate/` omits them.

No env var, no cron, no n8n import. No backfill — see above.

`npx tsc --noEmit` is clean and the suite is **3,856 / 3,859** (33 new tests, all
passing; the 3 failures are the pre-existing ones recorded in
[[main-has-three-failing-tests-2026-09-18]] and are unrelated to gifts).
`next build` was **not** run — a `next dev` was live on :3000 and they share
`.next/`.

## What is still open

- **`GiftTracker.tsx:207` keeps a private copy of `APPAREL_SIZES`**, duplicating
  `src/lib/gift-tracker/milestone-copy.ts`. Pre-existing, found while wiring the
  relationship list through the shared module and deliberately **not** fixed here
  — but it is the exact drift `milestone-copy.ts` was extracted to prevent, and
  the next person to add a size will update one of the two.
- **The relationship list lives in two places by design** — the TypeScript const
  and the SQL CHECK. The database is the backstop, not the definition; adding a
  relationship means an `ALTER` as well as an edit.
- **A recipient cannot be recorded for a leaver**, because the public page cannot
  help one at all ([gift-address-external-link.md](gift-address-external-link.md)
  § *What is still open*) and the Gift Tracker's roster is `active_employees`.
  The 16 owed gifts on offboarded people still have no route, with or without a
  spouse to receive them.

Siblings: [gift-address-external-link.md](gift-address-external-link.md) — the
public page this adds a block to · [gift-tracker-receipts.md](gift-tracker-receipts.md)
— the fulfilment ledger this deliberately does not touch ·
[gift-tracker-shipping-export.md](gift-tracker-shipping-export.md) — the file the
new columns land in.
