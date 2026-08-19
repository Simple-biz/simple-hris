# Gift Tracker — complete tenure-gift roster export (CSV / XLSX / PDF)

Approved blueprint (Kane, 2026-08-19), rev 2.

- **Q1 = whole roster.** "Even those people that didn't submit should be there — I
  want the whole complete list of people, like basically the master list." So the
  grain is **one row per person on the master list**, and submissions are *joined
  on*, never the thing that decides membership.
- **Q2** resolved by Q1 — there is no status filter to follow. Status is a column.
- **Q3** off-roster submitters are included and flagged.
- **Q4** = "if no milestone is reached doesn't matter" — a person with zero
  milestones still appears; the milestone columns read `None yet`. No
  approved-milestone-list column.

Purpose: Kane reconciles this against the tenure-gift Google Sheet to confirm the
right people are being shipped to. **Completeness is the product.** Anything that
silently drops or blanks a row is the exact failure this export exists to catch.

Modeled on `src/lib/hr/global-master-list-export.ts` + the inline `ExportMenu` at
`src/components/hr/HrGlobalMasterList.tsx:887`. Same three formats, same
client-side Blob path, no server round-trip. PDF is themed **emerald/teal** (the
Gift Tracker's palette), not the GML's CEO orange→rose.

## Invariants this build must hold

1. **Every roster person appears** — no start date, no milestone, no submission,
   all still get a row.
2. **Off-roster submitters are appended, flagged** — a submission whose
   `personal_email` matches no active roster row is the likeliest mis-ship; it can
   never vanish because roster grain didn't have a slot for it.
3. **Address provenance is explicit** — shipping address (what they submitted)
   and master-list home address are different things. Whichever is used, the
   `Address Source` column says which.
4. **No price, no gift name, ever.** `gift_price_php` / `gift_name` /
   `gift_catalog_item_id` are vestigial columns kept for history
   ([[gift-feature-info-only]]). A test asserts they never reach output.
5. **No silent truncation** — `listShippingDetails` must page.

## Column order (CSV + XLSX sheet 1 + the PDF's subset)

`#`, Name, Work Email, Personal Email, Department, Start Date, Tenure,
Milestones Reached, Current Milestone, Milestone Date, Due In, Submitted?,
Status, Shipping Address, Address Source, Contact Number, Apparel Size,
Employee Notes, Decided By, Decided At

XLSX gets a **second sheet, "All submissions"** — every submission row including
history, so the per-milestone detail the roster grain flattens is preserved.

## Tasks

- [ ] 1. `src/lib/supabase/employee-gift-shipping.ts` — `listShippingDetails`
      switches its bare `.select()` to `selectAllPaged`. PostgREST truncates at
      1000 rows even with `.range()`; under roster grain a truncated join does
      not shorten the export, it **blanks addresses on real people**.
- [ ] 2. `src/lib/gift-tracker/shipping-export.ts` — pure, client-safe:
      `buildGiftRosterExport(input)` → model; `giftRosterToCsv`;
      `buildGiftRosterWorkbook` (2 sheets); `generateGiftRosterPdf`;
      `downloadGiftRosterCsv` / `Xlsx` / `Pdf`. Milestone math delegates to
      `src/lib/gift-milestones.ts` — no second copy of the 6-month rule.
- [ ] 3. `src/lib/gift-tracker/shipping-export.test.ts` (`node:test`) —
      every roster person survives the join (no-start-date, never-submitted,
      zero-milestone); off-roster submitters appended and flagged; address
      fallback + its source label; milestone label = index x 6 months;
      CSV escaping of comma-bearing addresses; **no price / gift-name column**.
- [ ] 4. `src/components/orphanage/GiftTracker.tsx` — `ExportMenu` into the
      Roster sub-tab toolbar row, beside the search box. Roster search scopes
      the export (mirrors GML). Card must not clip the dropdown.
- [ ] 5. `npx tsc --noEmit` + `npm test` (check for a live `next dev` first —
      shared `.next/`).
- [ ] 6. Docs in the same commit: `docs/features/gift-tracker-shipping-export.md`,
      INDEX row 26, memory `gift-tracker-shipping-export` + MEMORY.md pointer.
