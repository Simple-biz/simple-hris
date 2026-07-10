# Orphanage 3rd Party Vendors (Directory + SIMPLE-branded Invoices)

A self-contained payment surface inside the **Orphanage dashboard** for the outside businesses the
orphanage buys goods/services from (a hardware shop, a printer, a caterer, …). The Orphanage Manager
maintains a **vendor directory**, raises a **SIMPLE-branded invoice** against a saved (or free-typed)
vendor with a line-item editor, and — once they've actually sent the money — **marks it paid**, which
stamps a diagonal **PAID** watermark on the rendered invoice. Built 2026-07-09; ships as SQL migration
**#108** (tracked in the pending-SQL list).

> **Deliberately separate from Payment Dispatch.** This surface has its **own two tables**
> (`orphanage_vendors`, `orphanage_vendor_invoices`) and **never** touches the payroll-clerk dispatch
> machinery (`orphanage_dispatches` / `payment_dispatches` / `disbursement_records`). **No n8n
> automation fires** — creating an invoice writes a row, marking it paid just stamps a payment record
> and the watermark. Do not wire it into DispatchReports or the disbursement tables.

Key files:

- [create_orphanage_vendors.sql](references/sql/create/create_orphanage_vendors.sql) — both tables, indexes, `updated_at` triggers, best-effort Realtime publication.
- [vendor.ts](src/lib/orphanage/vendor.ts) — client-safe types + pure helpers (formatters, totals, invoice-number suggester, banking check). No server imports.
- [orphanage-vendors.ts](src/lib/supabase/orphanage-vendors.ts) — vendor directory DB access (service-role).
- [orphanage-vendor-invoices.ts](src/lib/supabase/orphanage-vendor-invoices.ts) — invoice DB access; server owns the authoritative total.
- [orphanage-vendors/route.ts](app/api/orphanage-vendors/route.ts) · [[id]/route.ts](app/api/orphanage-vendors/[id]/route.ts) — vendor CRUD API.
- [orphanage-vendor-invoices/route.ts](app/api/orphanage-vendor-invoices/route.ts) · [[id]/route.ts](app/api/orphanage-vendor-invoices/[id]/route.ts) — invoice list/create/edit/mark-paid/delete API.
- [ThirdPartyVendorsPanel.tsx](src/components/orphanage/ThirdPartyVendorsPanel.tsx) — the tab: Invoices + Vendors sub-tabs, cards, dialogs.
- [VendorInvoiceBuilderDialog.tsx](src/components/orphanage/VendorInvoiceBuilderDialog.tsx) — vendor picker + line-item editor + live total.
- [VendorInvoiceDocument.tsx](src/components/orphanage/VendorInvoiceDocument.tsx) — pure `buildInvoiceHtml`, the preview dialog, and `printInvoice`.

---

## Data model

Two tables, both idempotent (`IF NOT EXISTS` / `OR REPLACE`), each with a `BEFORE UPDATE`
`updated_at` trigger, and each added to the `supabase_realtime` publication best-effort (the tab loads
via fetch + manual **Refresh** today — the publication only makes a future live subscription possible).

### `orphanage_vendors` — the directory

| Column | Notes |
|---|---|
| `business_name` | `NOT NULL`; the only required field. |
| `contact_name` / `contact_email` / `contact_phone` | free text, nullable. |
| `address_line1` / `address_line2` / `city` / `country` | kept as loose lines so foreign vendors render cleanly without a rigid schema. |
| `products_services` | what the vendor supplies. |
| `payables` | what Simple specifically needs to pay for. |
| `bank_name` / `account_holder_name` / `account_number` / `swift_code` / `routing_number` | banking, all `NOT NULL DEFAULT ''`. A vendor is either **SWIFT + account** (intl wire) **or** **routing + account** (domestic); both are stored, the invoice/UI shows whichever is filled. |
| `note`, `created_by`, `created_at`, `updated_at` | — |

Indexed on `lower(business_name)`. `vendorHasBanking()` treats a vendor as payable when it has an
account number **and** (a SWIFT **or** a routing number).

### `orphanage_vendor_invoices` — invoices raised against a vendor

- `vendor_id` → `orphanage_vendors(id)` **`ON DELETE SET NULL`**. Every vendor detail needed to render
  the document is **snapshotted onto the invoice row at create time** (`vendor_name`,
  `vendor_contact_name`, `vendor_email`, `vendor_phone`, `vendor_address` pre-joined, plus the five
  banking columns), so a paid/historical invoice still renders in full after the vendor is deleted.
- `line_items` `JSONB` (`[{ description, quantity, unit_price, amount }]`) + `total_amount NUMERIC(14,2)`.
- `status` `CHECK IN ('pending','paid')`, default `pending`.
- Payment record, filled on mark-paid: `paid_by`, `paid_at`, `paid_transaction_id`, `paid_bank_used`,
  `paid_sent_date`, `paid_note`.
- Indexes: `(status, created_at DESC)`, `(vendor_id)`, and a **unique** index on `invoice_number`.

---

## API

All routes run on the Node runtime, `force-dynamic`, and are gated on the `orphanage` view's
`third_party_vendors` feature: reads use `requireFeatureAccess('orphanage','third_party_vendors','view')`,
mutations use `requireFeatureEdit('orphanage','third_party_vendors')`. Reads are view-gated (not open to
any signed-in employee) because rows carry vendor **banking** details. Every mutation writes an
`insertAuditLog` entry.

| Method · Route | Action | Audit action |
|---|---|---|
| `GET /api/orphanage-vendors` | list vendors (alpha by name) | — |
| `POST /api/orphanage-vendors` | create vendor (requires `business_name`) | `orphanage.vendor.saved` (`created:true`) |
| `PATCH /api/orphanage-vendors/{id}` | update vendor | `orphanage.vendor.saved` (`created:false`) |
| `DELETE /api/orphanage-vendors/{id}` | delete vendor | `orphanage.vendor.deleted` |
| `GET /api/orphanage-vendor-invoices?status=pending\|paid` | list invoices (newest first) | — |
| `POST /api/orphanage-vendor-invoices` | create pending invoice | `orphanage.vendor_invoice.created` |
| `PATCH /api/orphanage-vendor-invoices/{id}` | `action:'mark_paid'` → pay; else edit pending | `orphanage.vendor_invoice.paid` / `.updated` |
| `DELETE /api/orphanage-vendor-invoices/{id}` | delete invoice | `orphanage.vendor_invoice.deleted` |

**Server owns the total.** `createOrphanageVendorInvoice` / `updateOrphanageVendorInvoice` re-run
`normalizeLineItem` (recomputes each `amount = round2(quantity × unit_price)`) and
`invoiceTotal` — a client-supplied sum is never trusted. Both routes require a non-empty
`invoice_number` and `vendor_name` and at least one **meaningful** line item (non-blank description or
non-zero amount).

**Concurrency guards.** `invoice_number` collisions trip the unique index and are surfaced as **409**
("That invoice number already exists"). Edit and mark-paid both query `.eq('status','pending')`, so a
paid invoice is an immutable snapshot: a second edit or double-click mark-paid returns
`Invoice not found or already paid` → **409**.

---

## The invoice document

`buildInvoiceHtml(invoice)` in `VendorInvoiceDocument.tsx` is a **pure builder** that returns a
self-contained HTML fragment (an inline `<style>` + markup, all classes namespaced `siv-`). The same
string feeds **both**:

- the on-screen preview dialog (`VendorInvoiceDocument`, via `dangerouslySetInnerHTML`), and
- `printInvoice()`, which opens a bare `window.open` document and calls `w.print()` — so **what you see
  is exactly what prints/saves as PDF**.

The letterhead carries the SIMPLE logo (`/simple-logo.png`); the doc bills "Simple · Orphanage Program".
When `status === 'paid'` a `.siv-watermark` element renders the diagonal **PAID** stamp and a
"Payment received" reference block (transaction id, bank used, date sent, marked-by, note). Every
interpolated user value goes through `esc()` / `multiline()` — the fragment is an injection surface.
Money is rendered via `formatVendorPHP` (₱, always 2 decimals).

`printInvoice` opens the print dialog only after the logo image loads (`img.onload`/`onerror`), with a
1200ms safety-net timer, so the logo isn't missing from the PDF.

---

## The tab (`ThirdPartyVendorsPanel`)

Two sub-tabs, **Invoices** (default) and **Vendors**, loaded together on mount and via a manual
**Refresh** button. Invoices are split into **Pending** and **Paid** sections; stat tiles show pending
count, pending total, and paid count. `VendorInvoiceBuilderDialog` lets the manager pick a saved vendor
(which snapshots its contact + banking into the form via `applyVendor`, all fields still editable) or
free-type a vendor name; it suggests an invoice number (`suggestInvoiceNumber`, e.g.
`INV-20260709-4821`) and shows a live-computed total. Mark-paid runs through
`VendorInvoiceMarkPaidDialog`; View/Print run through `VendorInvoiceDocument` / `printInvoice`.

---

## RBAC

The tab auto-provisions through the feature-permission catalog — no bespoke gate:

- [feature-permissions.ts](src/lib/rbac/feature-permissions.ts): `FEATURE_CATALOG.orphanage` includes
  `{ key: 'third_party_vendors', label: '3rd Party Vendors' }` (the `orphanage_manager` role maps to the
  `orphanage` view).
- [view-tabs.ts](src/lib/rbac/view-tabs.ts): `VIEW_TAB_IDS.orphanage` includes the tab id
  `'third-party-vendors'`.

Per the default-deny model, the tab is hidden unless an `employee_feature_permissions` row grants
`view`/`edit`; mutating routes additionally require `edit`.

---

## Gotchas (review fixes, 2026-07-09)

- **Double-print run-once guard.** In `printInvoice`, the image `load`/`error` listeners **and** the
  safety-net timer all call `doPrint`, but a `printed` boolean gates it so only the first fires —
  otherwise a second Print/Save-PDF dialog pops after the logo loads.
- **View-only read carve-outs.** `data-readonly-allow` marks the read-safe controls (the header nav /
  Refresh, and the per-card **View** and **Print** buttons) so they stay live for view-only users while
  the edit/delete/mark-paid actions are suppressed.
- **Dangling `vendor_id` nulled on vendor delete.** The DB FK is `ON DELETE SET NULL`; the panel mirrors
  that optimistically — on deleting a vendor it sets `vendor_id: null` on any local invoice that
  referenced it, and the builder dialog only pre-selects the vendor dropdown if that vendor still exists.
  Without this, editing such an invoice would re-send a dangling `vendor_id` and fail the FK.

---

## Related

- **Orphanage pay column** — manual per-employee orphanage pay in the payroll wizard (separate surface).
- **HR audit trail** — the `orphanage.vendor.*` / `orphanage.vendor_invoice.*` audit actions follow the
  same mutating-button-logs-an-entry convention.
- **Feature permissions overlay** / **RBAC default-deny** — how the tab is gated and auto-provisioned.
