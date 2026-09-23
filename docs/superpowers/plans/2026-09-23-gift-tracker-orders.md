# Gift Tracker → Orders — plan

Session `95df963a`, 2026-09-23. Approved by Kane in four answers:
Q1 no month batching (approved → Orders at once) · Q2 invoice carries price × qty ·
Q3 lock builds the PDF and freezes the order · Q4 reopen is allowed, and a locked order
leaves Open. Governing doc: `docs/features/gift-tracker-orders.md`.

## Task 1 — SQL
- [x] `references/sql/create/2026-09-23_gift_orders.sql`: `gift_orders`, `gift_order_lines`, partial unique `gift_order_lines_one_live_order`, `gift_order_lock`, `gift_order_reopen`, RLS on / no policies / EXECUTE revoked from PUBLIC, anon, authenticated
- [x] `scripts/apply-gift-orders-migration.mts` + `scripts/Apply Gift Orders migration.cmd`
- [x] Rehearsal (rolled back) passes: 15 object checks + 10 behavioural controls
- [ ] **Kane applies it** (PENDING)

## Task 2 — pure model
- [x] `src/lib/gift-tracker/orders.ts`: open lines, tier → items, size/variant resolution, problems, invoice groups, centavos
- [x] `orders.test.ts` (incl. the Tote Bag S/M/L must-not-be-sized case the first draft got wrong)

## Task 3 — PDF
- [x] `src/lib/gift-tracker/order-invoice.ts` from `(header, snapshot)` only; helpers exported from `shipping-export.ts`
- [x] `order-invoice.test.ts`; sample rendered and eyeballed

## Task 4 — route + guards
- [x] `app/api/gift-orders/route.ts` GET / POST lock (server re-prices, 409 on a stale total) / POST reopen
- [x] `app/api/employee-gift-shipping/[id]` PATCH + DELETE refuse a gift on a live order
- [x] audit actions `gift.order_locked`, `gift.order_reopened` in the registry note

## Task 5 — UI
- [x] `GiftOrders.tsx` (Open · Invoice preview · Locked orders), mounted second in `GiftTracker.tsx`
- [x] Gift items **Sized** toggle in `GiftCatalog.tsx`

## Task 6 — docs
- [x] feature doc · INDEX row · README row · components.md · api-reference.md · shipping-export.md price rule · memory · Open items 194
