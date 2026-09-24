# Gift Tracker Orders — approved tenure gifts locked into a priced PDF invoice

HR → Gift Tracker → **Orders** (the sub-tab after Submissions — Roster · Submissions · Orders; it sat beside Roster until Kane swapped it the same day). Every approved shipping
submission lands in **Open orders** the moment it is approved, whatever month it was
earned. HR ticks the gifts to send, the **Invoice preview** prices them from Gift items
(item · size · qty · unit · amount · total), and **Lock order & build PDF** writes the
invoice and downloads it for the vendor. **Locked orders** lists every invoice ever
locked; any of them re-downloads, a locked order can be **reopened**, and any order can
be **deleted**. Asked for by
Kane 2026-09-23; built in session `95df963a`.

## Key files

| Piece | File |
| --- | --- |
| Line resolution, sizes, invoice model, money | `src/lib/gift-tracker/orders.ts` (+ `orders.test.ts`) |
| Invoice PDF (pdf-lib) | `src/lib/gift-tracker/order-invoice.ts` (+ test) — reuses the branding helpers exported from `shipping-export.ts` |
| Persistence (server-only) | `src/lib/supabase/gift-orders.ts` |
| Route | `app/api/gift-orders/route.ts` — GET list · POST `lock` / `reopen` |
| Edit/delete freeze | `app/api/employee-gift-shipping/[id]/route.ts` → `refuseIfOnLockedOrder` |
| Tab | `src/components/orphanage/GiftOrders.tsx`, mounted by `GiftTracker.tsx` |
| Sized toggle | `src/components/orphanage/GiftCatalog.tsx` (Gift items → **Sized**) |
| Tables + functions | `references/sql/create/2026-09-23_gift_orders.sql` |
| Migration runner | `scripts/apply-gift-orders-migration.mts` · `scripts/Apply Gift Orders migration.cmd` |

## What is "open"

**An order is OPEN iff its submission is `approved` and no LIVE order line holds it.**
Nothing is stored for an open order — it is derived from the submissions the Gift
Tracker already loaded, so an approval shows up in Orders without a refresh. The
approval month does not matter (Kane: *"no matter which month it was earned"*); there
is no month batching.

**The Orders tab badge is the Open count** — distinct submissions with an open line
(`countOpenOrders`), blocked ones included, locked ones excluded, the same number the
Open list shows. `GiftTracker` reads the orders state on mount and on Refresh (so the
badge shows with the tab closed) and the open tab hands every fresh read back up
(`onState`), so a lock or reopen moves the badge with the list. Both go through the ONE
reader, `fetchOrdersState` (`src/lib/gift-tracker/orders-client.ts`). **A failed read or
an unapplied migration hides the badge — it is never shown as 0**, which would read as
"nothing to order".

One submission can send several items (the 24-month tier is *Tote Bag & Mug*), so
the unit is the **line** = one gift item on one submission, keyed
`orderLineKey(submissionId, item)`. The tab selects by submission (all its open lines
together).

## Where the gift, the size and the price come from

- **The gift is the anniversary TIER's `gift_items`** for that milestone (milestone N is
  the tier at year N/2) — see [[gift-feature-info-only]] and `anniversary-items.ts`.
  **Never** the vestigial `gift_name` / `gift_catalog_item_id` / `gift_price_php`
  columns on the submission; they still hold live-looking stale values.
- **The price is the Gift items row's `price_php`, in integer centavos.** When an item
  has several rows the line must resolve to ONE row:
  - **Sized (apparel) items take the employee's shirt size** (`apparel_size`, XS…3XL)
    and pick the row whose description is that size — Tshirt 2XL prices at ₱450, not ₱430.
    A single-row sized item (Hoodie Jacket) prints the employee's size too.
  - **Anything else with several rows needs HR to pick** (the variant dropdown on the
    line). The Tote Bag is the live case: its rows read Small/Medium/Large and the
    employee never chose one.
- **Sized** is an explicit per-item toggle in Gift items (`sized` on the catalog JSON,
  written to every row sharing the name). Absent, it is **inferred narrowly**: rows that
  are all sizes AND include a clothing-only size (XS, XL, 2XL, 3XL). "Small/Medium/Large"
  alone is deliberately NOT enough — that is exactly the Tote Bag, and a tote must never
  take someone's shirt size. The employee's size never prints on a non-sized item (no
  "Mug · M").

## A line that cannot be priced cannot be locked

`problem` on a line is one of `no_tier_gift` · `off_catalog` · `needs_variant` ·
`needs_size` · `no_price`. Such a line is flagged amber, its checkbox is disabled, and
the route refuses it (400). **It is never printed as ₱0 and never guessed.** A ₱0 /
blank price in Gift items counts as "no price" for the same reason. Live 2026-09-23 the
30-, 36- and 42-month tiers name off-catalog gifts (Polo, Speaker, Lamp) — they stay
blocked until Gift items has them.

## Locking: the server re-prices, the database refuses doubles

The browser sends only **which** submissions, HR's variant picks, display names, and
the total it showed. The route re-reads the approved submissions, the catalog and the
live locks itself, runs the SAME `resolveOrderLines` + `buildInvoice`, and:

- a submission no longer open (returned, deleted, or locked by someone else) → **409**;
- any line with a problem → **400**;
- a total different from the screen's (Gift items edited meanwhile) → **409 "prices
  changed, refresh"**, never a silent re-price.

`gift_order_lock` (plpgsql) then does it atomically: re-checks every submission is
`approved` under `FOR UPDATE`, inserts the order and its lines, and re-derives the
total from the lines. **The double-invoice guard is the partial unique index
`gift_order_lines_one_live_order` on `(submission_id, item) WHERE released_at IS NULL`** —
two people locking the same gift at once get one invoice and one 409, never two lines.

## The invoice is a snapshot

`gift_orders.snapshot` stores the invoice as locked — groups (item · size · qty · unit ·
amount), the delivery list (name · milestone · items · ship-to · contact · received-by)
and totals. **The PDF is always rebuilt from that snapshot, never from the live catalog
or the live submissions**, so re-downloading an old invoice prints exactly what went to
the vendor. `generateOrderInvoicePdf` takes only `(header, snapshot)` — there is no way
to hand it live data.

To keep the snapshot and the record from diverging, **a submission on a LIVE order
cannot be edited or deleted** (`PATCH`/`DELETE /api/employee-gift-shipping/[id]` → 409
naming the invoice). A failed check refuses too — "could not tell" is never "not
locked". Reopen the order first.

## Reopen keeps the invoice; Delete removes it

`gift_order_reopen` marks the order `reopened` (who, when, optional reason) and stamps
`released_at` on its lines, which frees those gifts back to Open orders and lets them be
locked again. **Reopen never deletes** — a reopened invoice still downloads, stamped
REOPENED / void. There is no un-reopen; lock the gifts again instead.

**Delete is the separate, explicit way to remove an invoice** (Kane ruled 2026-09-23,
session `95df963a`, answering the hard stop in audit item 195: *"Allow deleting please
ill remove it after if I dont need it"*). This REPLACES the earlier rule "the order row is
never deleted" — Reopen still keeps it; only Delete removes it.

- Button on every row of **Locked orders** (locked AND reopened), behind an inline
  confirm that says the gifts go back to Open and that a vendor's copy will no longer
  match anything here. Never on Open orders — removing an open order would mean
  un-approving the submission, which is a different act.
- Gate: `requireFeatureEdit('hr','gift_tracker')`, the same as lock and reopen (Kane did
  not pick a tighter one; admin-only was offered).
- `gift_order_delete` is atomic: the order and ALL its lines, or nothing. Deleting a
  LOCKED order frees its gifts (nothing holds them any more); deleting a reopened one
  moves no gifts.
- **The route reads the whole order + every line BEFORE deleting** and writes them to
  the `gift.order_deleted` audit entry once the delete succeeds (snapshot, lines, totals,
  who locked / reopened it). That entry is the only record of the invoice afterwards.
- Invoice numbers are an identity series: a deleted `GO-000012` is never reissued, so the
  sequence can have gaps. A gap is a deleted invoice, not a bug.

## The "Creating invoice" overlay tracks real work

`InvoiceProgress.tsx` (Kane, 2026-09-23) covers the tab while locking. **Every step is a
real phase, never a timer:** `locking` while the POST is in flight (server re-prices and
writes the order) → `pdf` once the order exists and the browser is building the PDF →
`done` only after both finished, held ~1.4s so the LOCKED stamp can land. A failed lock
closes it at once and the toast says why; a lock whose PDF failed closes it too (the
order IS locked — the toast says to download from Locked orders). It never plays a
success animation over a lock that did not happen. Honors `prefers-reduced-motion`.

## Price is allowed here and nowhere else

Gift items' price used to be reference-only, reaching no output
([gift-tracker-shipping-export.md](gift-tracker-shipping-export.md) § *Tenure gifts
carry no price*). **Kane ruled 2026-09-23 that the Orders invoice carries it** ("There
should be a price on that Invoice obviously on how many was ordered"). That is the ONE
priced output: the Roster and Submissions exports still carry no price and their two
no-price tests still hold, and nothing here touches approval, payroll or the dispatch
queue — **an invoice is not a payment.**

## Auth, audit, realtime

- GET `requireFeatureAccess('hr','gift_tracker','view')`; POST `requireFeatureEdit('hr','gift_tracker')` — the gate approval and the catalog already use.
- Audit: `gift.order_locked` (order_no, gifts, qty, total_centavos, submission_ids), `gift.order_reopened` (reason) and `gift.order_deleted` (the whole order + lines), actor = the verified session. Registered in `src/lib/audit/registry.ts` under `gift.`.
- Both tables: RLS on, **no policies**, **not** in `supabase_realtime`; all three functions (lock, reopen, delete) revoked from PUBLIC/anon/authenticated (Postgres grants EXECUTE to PUBLIC by default). The tab fetches `no-store` on mount and after every lock/reopen; it is never painted from the orphanage tab cache — lock state must not be stale.
- Reads page with `selectAllPaged`.

## Deploy notes

- **Migration PENDING** (not applied as of 2026-09-23): double-click
  `scripts/Apply Gift Orders migration.cmd` — rehearsal first (always rolled back), then
  type `APPLY`. Needs `DATABASE_URL` (session pooler) in `.env.local`. The rehearsal
  passed on 2026-09-23 against production (15 object checks + 10 behavioural controls,
  all rolled back; re-run after `gift_order_delete` was added — 18 object checks +
  14 behavioural controls, all passed). Until it is applied the Orders tab says "not set up yet" and the
  edit/delete freeze is a no-op (nothing can be locked).
- No env vars, no n8n import.
