# Employee Overview "Details" — Pay Snapshot Grid + Download PDF

**Date:** 2026-08-03
**Status:** Approved

## Goal

The Employee → Overview page has a **"Details"** button
([`EmployeeDashboard.tsx:2455-2466`](../../../src/components/employee/EmployeeDashboard.tsx#L2455-L2466),
mobile equivalent at [`2401-2411`](../../../src/components/employee/EmployeeDashboard.tsx#L2401-L2411))
that opens a "PAB & bonuses" dialog
([`mobileHelpOpen`](../../../src/components/employee/EmployeeDashboard.tsx#L656),
rendered at [`3566`](../../../src/components/employee/EmployeeDashboard.tsx#L3566)).
Inside it, a **"Pay snapshot"** section
([`3602-3691`](../../../src/components/employee/EmployeeDashboard.tsx#L3602-L3691)) lists the
current pay week's figures as stacked label/value rows, with no way to export them. This
feature turns that list into a tile grid and adds a one-page PDF download.

## Decisions (from brainstorming)

1. **Scope is the Pay snapshot section only.** The PAB status card and Tech bonus status card
   above it ([`renderPabBonusStatusRows`](../../../src/components/employee/EmployeeDashboard.tsx#L2006))
   are untouched — confirmed with the user rather than assumed.
2. **Grid tiles mirror the existing "live stat strip" color language.** The strip at the top of
   this same Overview page ([`2600-2719`](../../../src/components/employee/EmployeeDashboard.tsx#L2600-L2719))
   already colors PAB indigo, Tech sky, MESA teal, with plain zinc tiles for hours/pay. The new
   grid reuses those exact colors instead of inventing a new palette.
3. **Total/Take-home stays outside the grid.** It's the hero figure (bold, larger, with the USD
   line under it) — squeezing it into a tile would bury it. It remains a full-width highlighted
   row below the grid, same as today, including the MESA-emergency-payout variant
   (extra row + "Total deposited" footer) that appears when `mesaDisbursementPhp > 0`.
4. **PDF content is the Pay snapshot figures only** — not the PAB/Tech eligibility blurbs above
   it. Confirmed with the user (rejected alternative: including the full eligibility text, which
   would make the one-pager busier without adding anything the person doesn't already see in the
   grid).
5. **New PDF module, not a reuse of `paystub-export.ts`.** That module renders a *landscape*,
   multi-week table from a full `PayStubView` (the official, payroll-confirmed statement).
   `EmployeeDashboard`'s numbers are locally-computed **estimates** with a different shape
   entirely — there's no `PayStubView` to hand it. A new, small, portrait-only module is cleaner
   than bending an unrelated shape to fit.
6. **Follows the `coe-document.ts` conventions, not `paystub-export.ts`'s.** Use the shared
   [`embedPdfFonts`](../../../src/lib/pdf/fonts.ts#L108) (real ₱ glyph, not the older
   Helvetica + "PHP " sanitize fallback) and
   [`embedSimpleLogo`](../../../src/lib/pdf/logo.ts#L29) (base64-embedded, no runtime fetch of
   `/simple-logo.png`). Both are the newer, preferred pattern per `fonts.ts`'s own header comment.
7. **Explicit "estimate" disclaimer on the PDF.** These figures are estimates until payroll
   confirms them (the dialog already says this in its PAB copy). The official, confirmed
   statement is the *separate* "Open Paystubs" flow (`PayStubModal`, already has its own landscape
   PDF). Without a disclaimer, this new one-pager could be mistaken for that official document.
8. **Always exactly one page.** Content is short and fixed-shape (at most ~7 tiles + a footer
   row) — no pagination logic needed, and the PDF module should treat a page count other than 1
   as a bug, not a case to handle.
9. **The PDF module takes pre-formatted rows, not raw numbers.** Several on-screen values depend
   on more than the raw amount — e.g. PAB shows "—" while
   `perfectAttendanceBonusStatus === 'pending'` regardless of `pabBonusAmount`, and OT pay shows
   "—" vs "₱0.00" depending on `otHours` as well as `otPay`
   ([`3612-3623`, `3624-3633`](../../../src/components/employee/EmployeeDashboard.tsx#L3612-L3633)).
   Re-deriving those branches inside the PDF module would duplicate business logic and could drift
   from the screen. Instead, `EmployeeDashboard` builds a `{ label, value }[]` array using the
   *exact same* conditional expressions already in its JSX, and the PDF module just draws whatever
   strings it's given — the component stays the single source of truth for what each row says.

## Implementation

### 1. Grid markup (`EmployeeDashboard.tsx`)

Replace the `space-y-2` stack of `flex justify-between` rows
([`3607-3647`](../../../src/components/employee/EmployeeDashboard.tsx#L3607-L3647)) with a
`grid grid-cols-2 gap-2` of tiles, one per metric:

- Total hours, Regular pay, OT pay → plain/zinc tile.
- PAB → indigo tile (matches the stat strip).
- Tech bonus → sky tile.
- MESA contribution (only when `mesaDeductionPhp > 0`) → teal tile.

Each tile: uppercase micro-label (matches the `text-[9px] font-semibold uppercase tracking-wide`
styling already used for tile labels in the stat strip) + `tabular-nums` value underneath.

The divider + Total/Take-home block + MESA-emergency-payout block
([`3648-3691`](../../../src/components/employee/EmployeeDashboard.tsx#L3648-L3691)) stays exactly
as it is today, unchanged, below the new grid.

### 2. Download button (`EmployeeDashboard.tsx`)

The "Pay snapshot" label
([`3604-3606`](../../../src/components/employee/EmployeeDashboard.tsx#L3604-L3606)) becomes a
flex row with the label on the left and a small button on the right:

```tsx
<div className="flex items-center justify-between">
  <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
    Pay snapshot
  </p>
  <button type="button" onClick={handleDownloadSnapshot} disabled={snapshotDownloading}>
    {snapshotDownloading ? <Loader2 className="animate-spin" /> : <Download />}
    {snapshotDownloading ? 'Preparing…' : 'PDF'}
  </button>
</div>
```

Same spinner/"Preparing…" micro-interaction as `PayStubModal`'s existing download button
([`PayStubModal.tsx:164-181`](../../../src/components/paystub/PayStubModal.tsx#L164-L181)). New
local state `snapshotDownloading`, alongside the existing `mobileHelpOpen` state. `Download` needs
adding to the lucide-react import already at
[`EmployeeDashboard.tsx:5-18`](../../../src/components/employee/EmployeeDashboard.tsx#L5-L18).

The button only renders when `row` is truthy — the same guard already wrapping the whole Pay
snapshot section ([`3602`](../../../src/components/employee/EmployeeDashboard.tsx#L3602)), so no
extra null-checks are needed inside the handler.

### 3. New module: `src/lib/payroll/pay-snapshot-pdf.ts`

```ts
export interface PaySnapshotPdfRow {
  label: string;
  /** Already formatted for display, e.g. "42.50h", "₱5,250.00", "—", "+₱2,000.00". */
  value: string;
}

export interface PaySnapshotPdfInput {
  employeeName: string;
  department?: string | null;
  weekLabel: string; // e.g. "Jul 28 - Aug 3, 2026" or "All time · combined"
  /** One entry per visible grid tile, same order as on screen. */
  rows: PaySnapshotPdfRow[];
  totalLabel: string; // "Total" or "Take-home"
  totalValue: string; // formatted PHP
  usdEquivalent?: string | null; // formatted "≈$130.00 USD" line, already computed
  /** The MESA-emergency-payout variant: an extra payout row + a "Total deposited" grand total. */
  extraPayout?: { label: string; value: string } | null;
  grandTotal?: { label: string; value: string } | null;
}

export async function generatePaySnapshotPdf(
  input: PaySnapshotPdfInput,
  generatedAt: Date,
): Promise<Uint8Array>;

export async function downloadPaySnapshotPdf(
  input: PaySnapshotPdfInput,
  generatedAt?: Date,
): Promise<void>;
```

Layout (portrait US Letter, `PAGE_W = 612`, `PAGE_H = 792`, matching
[`coe-document.ts:46-47`](../../../src/lib/documents/coe-document.ts#L46-L47)):

1. Masthead: `embedSimpleLogo` (falls back to the "Simple" wordmark as text if embedding fails,
   same as every other exporter), "Pay Summary" title, `${employeeName} · ${department}`,
   `weekLabel`, generated timestamp — same masthead shape as `paystub-export.ts`'s
   [`generatePayStubsPdf`](../../../src/lib/payroll/paystub-export.ts#L473-L504) but portrait.
2. Body: the same label/value pairs as the on-screen grid, drawn as simple two-column rows (no
   need to replicate the tile borders — this is a document, not a UI).
3. Footer total: `totalLabel`/`totalValue` (bold, larger) + `usdEquivalent`, mirroring the
   on-screen hero row. When `extraPayout`/`grandTotal` are set (the MESA-emergency-payout case),
   draw them the same way the screen adds the extra payout row + "Total deposited" grand total
   below the first total.
4. Disclaimer line: *"Estimated figures — not an official pay stub. Your confirmed pay statement
   is available under Open Paystubs once processed."*
5. Standard footer rule + "Confidential" line + page number, matching every other export in this
   codebase (e.g. [`paystub-export.ts:633-643`](../../../src/lib/payroll/paystub-export.ts#L633-L643)).

`downloadPaySnapshotPdf` wraps `generatePaySnapshotPdf` with the same `downloadBlob` browser-download
helper duplicated in every other export module (10 existing copies — this codebase's established
pattern is to duplicate this ~10-line helper per file rather than share it); filename
`pay-summary-<slug(employeeName)>-<YYYY-MM-DD>.pdf`.

### 4. Wiring (`EmployeeDashboard.tsx`)

`handleDownloadSnapshot` builds `PaySnapshotPdfInput` entirely from values already computed in the
component — no new fetches. `rows` is built with the same conditionals as the JSX it mirrors, so
each row's `value` string is computed identically to what's already on screen:

| Field | Source |
|---|---|
| `employeeName`, `department` | `profileForShipping.name`, `.department` ([`658-664`](../../../src/components/employee/EmployeeDashboard.tsx#L658-L664)) |
| `weekLabel` | Same string the header's "Pay Week" selector shows: `formatSourceFileLabel(selectedFile)` or `'All time · combined'` ([`2507-2511`](../../../src/components/employee/EmployeeDashboard.tsx#L2507-L2511)) |
| `rows[].value` for Total hours, Regular pay, OT pay | Same expressions as [`3609-3623`](../../../src/components/employee/EmployeeDashboard.tsx#L3609-L3623): `${totalHours.toFixed(2)}h`, `regularPay != null ? formatPHP(regularPay) : '—'`, the three-way OT branch (`otPay`/`otHours`) |
| `rows[].value` for PAB | Same branch as [`3624-3633`](../../../src/components/employee/EmployeeDashboard.tsx#L3624-L3633): `perfectAttendanceBonusStatus === 'pending' ? '—' : pabBonusAmount > 0 ? '+'+formatPHP(pabBonusAmount) : formatPHP(0)` |
| `rows[].value` for Tech bonus | `technologyBonusAmount > 0 ? '+'+formatPHP(technologyBonusAmount) : formatPHP(0)` ([`3634-3639`](../../../src/components/employee/EmployeeDashboard.tsx#L3634-L3639)) |
| MESA contribution row (included only when `mesaDeductionPhp > 0`) | [`3640-3647`](../../../src/components/employee/EmployeeDashboard.tsx#L3640-L3647) |
| `totalLabel`/`totalValue` | `mesaDisbursementPhp > 0 ? 'Take-home' : 'Total'` / `formatPHP(takeHomePhp)` ([`3649-3656`](../../../src/components/employee/EmployeeDashboard.tsx#L3649-L3656)) |
| `usdEquivalent` | The `≈ … USD` line ([`3679-3688`](../../../src/components/employee/EmployeeDashboard.tsx#L3679-L3688)), pre-formatted |
| `extraPayout`, `grandTotal` | Set only when `mesaDisbursementPhp > 0`, from [`3657-3673`](../../../src/components/employee/EmployeeDashboard.tsx#L3657-L3673) |

## Error handling

- Logo/font embedding failures fall back silently (text wordmark / Helvetica +
  "PHP " sanitize), same as every other exporter — never blocks the download.
- `generatePaySnapshotPdf` itself doesn't fetch anything, so there's no network failure mode to
  handle; a thrown error (e.g. pdf-lib internal failure) surfaces the same way `PayStubModal`'s
  download button handles it today — the `finally` clears `snapshotDownloading`, no toast.

## Testing

- New `src/lib/payroll/pay-snapshot-pdf.test.ts` (node:test, matching
  [`coe-document.test.ts`](../../../src/lib/documents/coe-document.test.ts)'s style): build with
  representative sample input, reload via `PDFDocument.load`, assert `getPageCount() === 1`,
  non-trivial byte length, and that `₱` round-trips (reuse the same assertion style as
  [`coe-document.test.ts:45-54`](../../../src/lib/documents/coe-document.test.ts#L45-L54)).
- Typecheck + `next build`.
- Manual: open Overview → Details, confirm the grid renders correctly with and without MESA rows,
  click Download PDF, open the file and confirm it's one portrait page with the disclaimer line.

## Out of scope

- PAB status card / Tech bonus status card in the same dialog — unchanged.
- `PayStubModal` and its existing landscape PDF (the official, confirmed statement) — unchanged.
- No new API routes, no schema changes, no changes to how the snapshot figures themselves are
  calculated.
