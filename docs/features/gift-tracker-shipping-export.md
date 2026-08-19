# Gift Tracker — Tenure Gift Roster export (CSV / XLSX / PDF)

An **Export** dropdown on HR → Gift Tracker → **Roster** sub-tab that downloads the
complete tenure-gift roster in three formats. It exists for one job: Kane
reconciles it against the tenure-gift Google Sheet to confirm the right people are
being shipped to. Shipped 2026-08-19, session `dd69f0d4`.

Everything runs **client-side** (in-memory Blob download, no server round-trip) —
the roster and the submissions are already loaded in the tab.

## Key files

| Piece | File |
| --- | --- |
| Export model + all three serializers | `src/lib/gift-tracker/shipping-export.ts` |
| Tests | `src/lib/gift-tracker/shipping-export.test.ts` |
| `GiftExportMenu` + toolbar wiring | `src/components/orphanage/GiftTracker.tsx` |
| Milestone math (shared, not duplicated) | `src/lib/gift-milestones.ts` |
| Submission read (paged) | `src/lib/supabase/employee-gift-shipping.ts` |

## The grain is the master list, not the submissions table

**One row per person on the roster.** Submissions are *joined on*; they never
decide membership. A person with no start date, no milestone reached, and no
submission still gets a row — `Current Milestone` reads `None yet` and
`Submitted?` reads `No`.

This is the whole invariant. The export is compared against a Google Sheet, so the
person who never filled the shipping form in is exactly the finding the comparison
exists to produce. An export that only listed submissions would agree with the
sheet **by omission** and hide the gap. If you are tempted to "clean up" the file
by dropping empty rows, you have deleted the product.

The `dueNoSubmission` counter in the PDF summary band is that gap made numeric:
people whose milestone window is open who have not submitted.

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

## Deploy notes

**No migration.** Every column already exists; no new table, route, env var, cron,
or n8n import. `npx tsc --noEmit` is clean and the 21 module tests pass.
`next build` was **not** run — a `next dev` was live on :3000 and they share
`.next/`.

Sibling: [hr-global-master-list-export.md](hr-global-master-list-export.md) — this
module is modeled on it and the two should stay structurally in step.
