# Gift Tracker exports — Roster (CSV / XLSX / PDF) and Submissions (CSV)

**Two exports, two grains, both correct.** An **Export** dropdown on HR → Gift
Tracker → **Roster** downloads the complete tenure-gift roster in three formats
(shipped 2026-08-19, session `dd69f0d4`); an **Export CSV** button on HR → Gift
Tracker → **Submissions** downloads the submissions in view (shipped 2026-09-22).
"In view" means the status pill + search, **never the page**: the Submissions list
pages at 20 (2026-09-23), and the export, the pill counts and the total all read
the full filtered list, not the 20 on screen.
The Roster file answers *who have we not heard from*; the Submissions file answers
*what did these people send us*. Neither is the other one done wrong — see
[§ The Submissions export](#the-submissions-export--the-other-grain-on-purpose).

> **The Google Sheet is no longer the ledger of record (2026-09-11).** This
> document used to open by saying the export exists so Kane could reconcile it
> against the tenure-gift Google Sheet. That premise is retired: the sheet was
> imported into `employee_gift_receipts` and **HRIS now owns who has and has not
> received a tenure gift** — see
> [gift-tracker-receipts.md](gift-tracker-receipts.md). The export keeps its job
> (one complete, comparable file of the whole roster) and gains four fulfilment
> columns, but a disagreement between this file and the sheet is now the sheet
> being stale, not HRIS.

Everything runs **client-side** (in-memory Blob download, no server round-trip) —
the roster and the submissions are already loaded in the tab.

## Key files

| Piece | File |
| --- | --- |
| Export model + all three serializers | `src/lib/gift-tracker/shipping-export.ts` |
| Submission-grain model + CSV | same file — `buildGiftSubmissionsExport` / `giftSubmissionsToCsv` |
| Column list shared by both submission outputs | same file — `GIFT_SUBMISSION_COLUMNS` |
| Tests | `src/lib/gift-tracker/shipping-export.test.ts` |
| `GiftExportMenu` (Roster) + `SubmissionsPanel` button | `src/components/orphanage/GiftTracker.tsx` |
| Milestone math (shared, not duplicated) | `src/lib/gift-milestones.ts` |
| Fulfilment state (shared, not duplicated) | `src/lib/gift-tracker/receipts.ts` |
| Submission read (paged) | `src/lib/supabase/employee-gift-shipping.ts` |
| Fulfilment read (paged) | `src/lib/supabase/employee-gift-receipts.ts` |

## The grain is the master list, not the submissions table

**One row per person on the roster.** Submissions are *joined on*; they never
decide membership. A person with no start date, no milestone reached, and no
submission still gets a row — `Current Milestone` reads `None yet` and
`Submitted?` reads `No`.

This is the whole invariant, and it survives the ledger move intact. The person
who never filled the shipping form in is exactly the finding this file exists to
produce; an export that only listed submissions would hide the gap **by
omission**. If you are tempted to "clean up" the file by dropping empty rows, you
have deleted the product.

The `dueNoSubmission` counter in the PDF summary band is that gap made numeric:
people whose milestone window is open who have not submitted.

## Fulfilment columns (2026-09-11)

Four columns come from `employee_gift_receipts` via `buildPersonReceiptSummary`
— the same helper the on-screen tracker uses, so the file and the screen cannot
disagree about who is owed a gift:

| Column | Meaning |
| --- | --- |
| `Gifts Received` | milestones somebody recorded as given |
| `Gifts Owed` | milestones that came due and were recorded as NOT given |
| `Oldest Owed` | the lowest-indexed owed milestone, e.g. `12-month` |
| `Not Recorded` | due milestones **nobody has assessed** |

**`Not Recorded` is never folded into `Gifts Owed`.** A due milestone with no
receipt row means nobody has said either way — 239 active people were absent from
the 2026-09-11 source sheet — and counting them as owed would invent a backlog.
Omitting the `receipts` input entirely must likewise read as "nobody has said",
not "nobody got anything"; a test pins that, because a wiring mistake would
otherwise print the company as owing every gift it has ever given.

The summary band gains `Gifts owed` (a person owed three counts three),
`People owed`, and `Not recorded` — three numbers, never one.

**Receipts are keyed on WORK email**, not the roster key. `personal_email` is not
injective on this roster (two people share one, a third has none), which is why
fulfilment is a separate table — see
[gift-tracker-receipts.md](gift-tracker-receipts.md). `exportReceipts` in
`GiftTracker.tsx` is scoped to the rows in view, exactly like
`exportSubmissions`, so the counts in the file match the counts on the screen.

Off-roster submitters report zeroes across all four: with no master row there is
no start date, so no milestone can be dated and nothing about fulfilment is
knowable. The `Off-roster` flag, not those counts, is the finding.

## Off-roster submitters are appended, never dropped

Submissions are keyed by `personal_email`; roster membership is keyed by
`personal_email ?? work_email`. A submission matching no active roster row
(offboarded, or they changed their personal email) has no slot under roster grain
— so those rows are **appended after the roster block**, `Department` set to
`Off-roster`, `Work Email` `-`.

They are not an edge case to tidy away: a submitter the roster has lost track of
is the single likeliest person to be mis-shipped.

When a **search** is active, `exportSubmissions` in `GiftTracker.tsx` keeps
in-view roster keys plus off-roster keys that themselves match the needle. Passing
*all* submissions while passing only *filtered* employees would relabel every
filtered-out colleague as a ghost — that is why the scoping memo exists rather
than just handing the export `shippingByEmail` wholesale.

## Two addresses exist — the file always says which one it printed

| Source | Meaning |
| --- | --- |
| `Submitted` | `preferred_delivery_location` from their submission for the current milestone. Wins. |
| `Master list` | Their home address, composed from `global_master_list`. Used when there is no submission. |
| `None on file` | Neither exists. |

Silently mixing the two would make the sheet comparison lie, so `Address Source`
is a column, not an inference.

The home address is composed from **BASE-tier** columns only —
`street` / `city` / `province` / `postal_code`, falling back to `full_address`.
`location` and `phone_number` come from the **EXTENDED** select tier
(`GLOBAL_MASTER_SELECT_EXT`) and degrade to `undefined` when the
`active_employees` view is stale, so they are last-resort enrichment and must
never become the sole source of an address.

## Milestone labels delegate to `gift-milestones.ts`

`milestone_index` N is the **(N × 6)-month** gift — index 4 prints `24-month`.
`Current Milestone` is `getCurrentShippingMilestone`, the same predicate the
employee dashboard uses to decide whether to show the shipping form, so the export
and the employee's own screen can never disagree about which milestone is open.
`Milestones Reached` is `buildMilestones(...).history.length`.

The `-month` spelling itself moved **into `gift-milestones.ts`** on 2026-09-11
when the receipts ledger needed it too; the wrapper here still owns the
`None yet` case and delegates for the rest. Do not reintroduce a local copy.

**Do not add a second date rule here.** `parseStartDate` reads a date-only
`start_date` as UTC midnight, which renders a day early west of UTC. Production
users are Manila (UTC+8) where this is correct, and the on-screen tracker behaves
identically — the export matching the screen matters more than the export being
independently "right". The test derives its expectation from the shared helpers
for exactly this reason; a hardcoded date string there fails in a US timezone.

## Tenure gifts carry no price — the export must not imply one

`gift_price_php`, `gift_name` and `gift_catalog_item_id` still sit on
`employee_gift_shipping_details` as **vestigial history columns**
(see [[gift-feature-info-only]] — the payment side was stripped 2026-07-14 and the
columns were kept only so old rows survive). They hold live-looking values.

They are absent from every output, `GiftRosterSubmissionInput` does not declare
them, and two tests pin it: one rejects any column header containing
price/cost/amount/PHP/catalog, the other feeds a submission carrying all three
fields and asserts none reach the CSV.

**The Catalog shows a price again, and THESE exports still carry none** (2026-09-23,
`d4cf4d17`, Kane ruled (b)): the Gift items table has an editable **Price (PHP)**
column bound to the catalog's stored `price_php`. It is on Gift items alone
(Anniversary Gifts has no price). It never reaches approval, the shipping export, the
submissions export, or payroll, and both tests above still hold.

**Exactly ONE output carries that price: the Orders invoice** (Kane ruled 2026-09-23,
session `95df963a`: *"There should be a price on that Invoice obviously on how many
was ordered"*). It snapshots the price at lock time and lives in its own module — see
[gift-tracker-orders.md](gift-tracker-orders.md). That ruling does not reach these two
exports: a price column here is still a defect, and the tests above still fail on one.

## The submission read must stay paged

`listShippingDetails` uses `selectAllPaged`. It was a bare `.select()`; PostgREST
truncates at 1000 rows **even with `.range()`**. Under roster grain a truncated
read does not shorten the export — it blanks the shipping address on real people
and prints them as "Not submitted". That is the worst available failure for a ship
list, so this is not an optimization.

## Formats

- **CSV** — one flat table, UTF-8 BOM, RFC-4180 escaping (Philippine addresses are
  full of commas), six-line provenance preamble.
- **XLSX** — sheet 1 `Gift Roster` (one row per person) + sheet 2
  `All submissions` (every submission incl. milestone history, so the detail the
  roster grain flattens is preserved). Autofilter on both. No cell fills — the
  community SheetJS writer drops them, and no freeze panes for the same reason.
- **PDF** — **landscape** US Letter (portrait cannot hold the address column),
  emerald→teal themed to the Gift Tracker rather than the GML export's CEO
  orange→rose. pdf-lib Helvetica is WinAnsi-only, so all text goes through
  `sanitize()`.

The Roster `Card` carries `overflow-visible` — `components/ui/card.tsx` is
`overflow-hidden` by default and would clip the dropdown when the roster is short.

## The Submissions export — the other grain, on purpose

HR → Gift Tracker → **Submissions** has its own **Export CSV** button:
`buildGiftSubmissionsExport` → `giftSubmissionsToCsv` →
`downloadGiftSubmissionsCsv`, filename `tenure-gift-submissions-YYYY-MM-DD.csv`.
One row per submission actually on file.

Read § *The grain is the master list* above before touching either file. That
section forbids reducing the **Roster** export to the submissions table, and the
reason still holds: a person who never filled the form in is the finding, and a
submissions-only roster file would hide them by omission. **That rule is about
the Roster file.** It is not an argument that a submission-grain file must not
exist — the Submissions sub-tab is a work queue, every row is something somebody
typed that somebody else must approve, reject or ship, and "what did these people
send us" is a shipping-desk question rather than a reconciliation one.

The failure mode is not the two files disagreeing. It is a future reader finding
one of them and *fixing* the other to match. If you are about to make the Roster
export submissions-only, or make the Submissions export list people who never
submitted, you are deleting one of the two products.

They cannot drift in their vocabulary, because there is only one:
`GiftSubmissionRecord` and `GIFT_SUBMISSION_COLUMNS` serve both this CSV and the
Roster workbook's `All submissions` sheet. Add a column once and both gain it.

### What you see is what you get

The file is the panel's `filtered` array, **in its on-screen order**. The builder
never re-sorts — the panel's pending-first-then-newest-edit order *is* the review
order the team works in, and a file that re-sorted itself would stop matching the
screen it was taken from.

**The scope is stated, never implied.** The filter pills default to **Pending**,
so an unstamped file would read as the whole queue while holding a fraction of
it. Three guards, and none of them is decorative: the scope label
(`Pending · search "cebu"`) is a preamble line, the summary prints `N of TOTAL`,
and the button carries the count of the rows it will write.

### Identity is the work email, here too

`summary.people` counts distinct **work** emails, falling back to the submission
key only when there is no roster match. `personal_email` — which is what
submissions are keyed on — is not injective on this roster: two colleagues share
one. Counting distinct submission keys would silently merge them into a single
"person", the same bug § *The grain is the master list* records being fixed in the
roster builder.

### Off-roster is passed in, never guessed

`GiftSubmissionsRowInput.offRoster` is set by the caller from the same
`rowsByEmail` map the list renders from, so the file and the screen cannot
disagree about who is a ghost. Such a row prints `Off-roster` in **Department**
and `-` in **Work Email** — a person with no roster row has no work email, and
printing their personal address in a company-email column would be a lie the
shipping desk cannot see through. `Department` **is** the flag; do not add a
second boolean column saying the same thing.

### Two timestamps, never one

`Submitted At` is `created_at`; `Last Submitted` is `updated_at`. Both are
**optional** on `GiftRosterSubmissionInput` because it is the loose structural
subset the roster's rows are assigned to — an absent value prints `-` and must
**never** be back-filled from the other, which would claim a row had never been
edited after somebody read it. `Reviewer Note` is `decision_note`, the reviewer's
own words. The three columns were added 2026-09-22 and the Roster workbook's
history sheet gained them in the same change, because the list is shared.

`SUBMISSION_COLUMN_WIDTHS` must stay the same length as
`GIFT_SUBMISSION_COLUMNS`. It held 14 entries for 17 columns until 2026-09-22, so
every width from `Alternate Recipient` rightwards was landing on the wrong column.

## Deploy notes

**No migration for this module.** Every column it reads already existed; no env
var, cron, or n8n import. The fulfilment columns added 2026-09-11 depend on
`employee_gift_receipts` — see
[gift-tracker-receipts.md](gift-tracker-receipts.md) § Deploy order. When that
table is absent the columns simply read `0` / `Not Recorded`, which is the
correct answer rather than a crash.

The Submissions CSV added 2026-09-22 needs **nothing** — no migration, no env
var, no route, no gate of its own. It is an in-memory Blob built from rows the
tab has already loaded and already gates on `hr / gift_tracker`, and the button
carries `data-readonly-allow` because downloading what you can already see is not
a write.

`npx tsc --noEmit` is clean and the module tests pass (21 at 2026-08-19, 31 after
the fulfilment work, **53 after the submissions CSV** — 171 across
`src/lib/gift-tracker/`). `next build` was **not** run in any of the three
sessions — a `next dev` was live on :3000 each time and they share `.next/`.

Sibling: [hr-global-master-list-export.md](hr-global-master-list-export.md) — this
module is modeled on it and the two should stay structurally in step.
