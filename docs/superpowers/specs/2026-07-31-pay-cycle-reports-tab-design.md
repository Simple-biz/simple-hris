# Accounting → Documents → Reports (Pay Cycle Reports)

**Date:** 2026-07-31
**Status:** Approved (pending written-spec review)

## Goal

Give the Accounting team a place to **publish a pay-cycle report** once they
have finished paying everyone in Payment Dispatch, and to keep those published
reports as a permanent, exportable record of **who got paid**.

Today Payment Dispatch → Reports derives a report for *every* cycle
automatically, live from `disbursement_records` / `payment_dispatches`. That is a
working queue view: it changes whenever a payment is undone or re-marked, and it
says nothing about whether Accounting considers the cycle *closed*.

This feature adds the missing act of **declaring a cycle finished**: a manual,
deliberate, obvious button that Accounting presses when the week is done, which
freezes the cycle as it stands and posts it as a report in
Accounting → Documents → **Reports**.

## Decisions (from brainstorming)

1. **Storage:** a frozen JSON snapshot in `app_settings`, one row per cycle. No
   migration, no deploy step. Chosen over a dedicated table because the report
   content is fully derivable from existing tables — the only genuinely new fact
   is *the publication itself* — and over a live-derived marker because a
   published report must not change retroactively when a dispatch is undone.
2. **Button scope:** the current Payment Dispatch cycle **plus** any earlier
   fully-paid-but-unpublished week, each publishable independently, so a week
   that slipped by can still be reported.
3. **Exports:** CSV, XLSX and PDF all generated **client-side** from the frozen
   snapshot, mirroring [`src/lib/transfers/transfers-export.ts`](../../../src/lib/transfers/transfers-export.ts).
   No server export routes, no stored files.
4. **Publication is reversible.** A mistaken publish would otherwise be
   permanent, and unpublish→republish is the only way to refresh a stale
   snapshot. Both directions are audited.
5. **No new permission.** The Reports tab rides the existing accounting
   `documents` feature: `view` to read, `edit` to publish or unpublish.

## Surfaces

### Inner tab bar

[`AccountingDocuments.tsx`](../../../src/components/accounting/AccountingDocuments.tsx)
currently renders a single view. It gains an inner tab bar directly under the
page header:

```
Documents
┌─────────────────┬───────────┐
│ Signing queue 3 │ Reports 1 │
└─────────────────┴───────────┘
```

- **Signing queue** — the existing signature manager + requests table, moved
  into a tab panel and otherwise untouched.
- **Reports** — the new `PayCycleReports` component.
- Tab pill styling follows `ViewTabButton` in
  [`AccountingMesa.tsx:2168`](../../../src/components/payroll/AccountingMesa.tsx#L2168)
  (`motion.span` + `layoutId`), recoloured to the Documents tab's orange.
  `layoutId` must be unique to this group (`accounting-documents-tab-pill`).
- The **Reports** tab carries an amber count badge when one or more cycles are
  ready to publish, so the call to action is visible from the signing queue too.
- The header subtitle and the Refresh button both follow the active tab.
- Default tab is **Signing queue** (today's behaviour). The choice is remembered
  in `localStorage` under `accounting-documents-tab`, restored after mount so SSR
  markup stays deterministic — same pattern as `REPORTS_VIEW_STORAGE_KEY` in
  [`DispatchReports.tsx`](../../../src/components/payroll-clerk/DispatchReports.tsx).

### Reports tab — list view

Top to bottom:

1. **Publish card** for the most recent unpublished cycle, in one of three
   states (below).
2. **Also unpublished** — a compact list of earlier fully-paid, unpublished
   cycles, each with its own `Publish` button.
3. **Published reports** — a card grid, newest period first (same card shape as
   PD's `ReportCard`, no cards/table toggle): cycle label, period,
   published-by/at, payee count, total paid. Click opens the detail view.

```
╔═ READY ═══════════════════════════════════════╗   amber ring + slow pulse
║ ● Jul 26 – Aug 1, 2026            100% paid   ║
║   1,296 payees · $184,220.14 · ₱10,412,338    ║
║                                               ║
║            ┃ ✓ Payment cycle complete ┃       ║   large, gradient
╚═══════════════════════════════════════════════╝

┌─ NOT READY (muted, disabled) ─────────────────┐
│ Jul 26 – Aug 1, 2026               94% paid   │
│ 71 still pending · 3 blocked                  │
│ Finish the queue in Payment Dispatch first.   │
└───────────────────────────────────────────────┘

┌─ ALL PUBLISHED ───────────────────────────────┐
│ ✓ Every completed cycle has been reported.    │
└───────────────────────────────────────────────┘
```

The **not-ready** state is deliberately still visible (muted, disabled, with the
remaining counts spelled out) rather than hidden: it tells Accounting *why* they
cannot close the week yet and where to go.

### Confirm dialog

> **Has this payment cycle been completed?**
> Jul 26 – Aug 1, 2026 · 1,296 payees · $184,220.14
> This freezes the cycle exactly as it stands now and posts it to Reports.
> Later undos or re-marks won't change the published report.
>
> `Cancel` · `Yes — publish report`

### Report detail view

Replaces the list in place, with a `← Back` — the navigation shape
`DispatchReports` already uses, not a modal.

- Four headline stat cards: Payees · Total paid (USD) · Total paid (PHP) ·
  Published (by + when).
- Paid-by-processor grid over `DISPATCH_PROCESSORS`.
- **Who got paid** table — searchable by name/email, paginated: Name · Email ·
  Type (contractor chip) · Processor · USD · PHP · Txn ID · Bank used · Date
  sent.
- `Export CSV` · `Export XLSX` · `Export PDF` in the detail header.
- `Unpublish` in the detail header, edit-gated, behind a two-step confirm.

## Data model — no DDL

One `app_settings` row per published cycle.

**Key:** `documents.pay_cycle_report.<source_file>`
(`payCycleReportKey(sourceFile)`; `PAY_CYCLE_REPORT_PREFIX = 'documents.pay_cycle_report.'`)

**Value:** JSON `PayCycleReportSnapshot`

| field | type / notes |
|---|---|
| `version` | `1` — lets a future shape change degrade instead of crash |
| `published_at` | ISO timestamp |
| `published_by` | resolved display name, else email local part |
| `published_by_email` | session email |
| `source_file` | the cycle's Hubstaff `source_file` (the identity) |
| `cycle_id` | `hubstaff_uploads.id` or `source:<file>`, for cross-linking to PD Reports |
| `label` | e.g. `"Jul 26 – Aug 1, 2026"` |
| `period_start` / `period_end` | ISO `YYYY-MM-DD`, nullable |
| `totals` | `{ payeeCount, employeeCount, contractorCount, dispatchCount, paidUSD, paidPHP }` |
| `byProcessor` | `{ [processorId]: { count, usd, php } }` |
| `payees[]` | `{ name, email, payeeType, processor, amountUSD, amountPHP, transactionId, bankUsed, dateSent, arrivalDate }` |

Server helper: `src/lib/accounting/pay-cycle-reports.ts` (`server-only`) —
`payCycleReportKey`, `listPayCycleReports`, `getPayCycleReport`,
`listPublishableCycles`, `buildPayCycleReportSnapshot`, `publishPayCycleReport`,
`unpublishPayCycleReport`.

Listing is a prefix scan: `.like('documents.pay_cycle_report.%')` over
`app_settings`. Published cycles number in the dozens per year, so the
PostgREST 1000-row cap is not a concern here; the read is nonetheless written as
a single `.like()` select of `key, value, updated_at` so the cap is a visible
ceiling rather than a hidden one.

### Row granularity

`payees[]` holds **one row per `payment_dispatches` row with `status = 'paid'`**,
so every transaction ID is individually traceable to the bank statement. The
headline `payeeCount`, however, uses Payment Dispatch's own distinct rule —
**distinct employee emails + one per contractor invoice** (see `distinctPaidCount`
in [`PayrollDispatch.tsx:405`](../../../src/components/payroll-clerk/PayrollDispatch.tsx#L405)) —
so the report's headline count can never disagree with the number the dispatch
screen showed when the clerk pressed the button. `dispatchCount` carries the raw
row count alongside it.

## Eligibility — when the button lights up

Derived from `listDisbursementReports()`, the same source PD Reports reads.

A cycle is **complete** when:

```
totals.paidCount > 0
  && totals.notPaidCount + totals.thresholdCount
     + totals.problemCount + totals.outstandingCount === 0
```

This is PD's own 100% rule — nothing pending, nobody blocked, at least one paid —
expressed against the report totals rather than the live queue, so the Reports
tab needs no wizard/queue hydration to decide.

- `urgent_*` cycles are **excluded**: they are one-off payouts, not pay cycles.
- A cycle that already has a snapshot is filtered out of `publishable` and
  appears in `published`.
- `publishable` is sorted newest period first; the first entry drives the big
  card, the rest the "Also unpublished" list.
- When nothing is publishable, the card shows the most recent *incomplete*
  cycle in the muted not-ready state, with its remaining counts; if there is no
  incomplete cycle either, the all-published confirmation shows.

## API — `app/api/accounting/pay-cycle-reports/`

| route | behaviour |
|---|---|
| `GET /` | `{ published: PayCycleReportSummary[], publishable: PublishableCycle[], incomplete: IncompleteCycle \| null }`. Summaries omit `payees[]` so the list payload stays small. |
| `GET /[sourceFile]` | the full snapshot |
| `POST /` `{ source_file }` | builds the snapshot **server-side** — never trusts client numbers — re-verifies completeness, then plain `INSERT` (never upsert) so a double-click or two clerks racing cannot republish; a duplicate key returns `{ already: true }`. Audit-logs `pay_cycle_report.published`. |
| `DELETE /[sourceFile]` | deletes the row. Audit-logs `pay_cycle_report.unpublished`. |

Gate: `requireFeatureAccess('accounting', 'documents', 'view')` on reads,
`'edit'` on `POST`/`DELETE` — matching
[`app/api/accounting/documents/route.ts`](../../../app/api/accounting/documents/route.ts).

The completeness re-check on `POST` is the important one: it is what stops a
stale browser tab from publishing a cycle that has since had a payment undone.
Failure returns `409` with the remaining counts so the UI can explain itself.

## Exports — `src/lib/accounting/pay-cycle-report-export.ts`

Modelled directly on [`transfers-export.ts`](../../../src/lib/transfers/transfers-export.ts),
reusing its structure and the Accounting warm orange→rose theme:

- `buildPayCycleReportExport(snapshot)` → `PayCycleReportExportModel`
- `payCycleReportToCsv(model)` — flat table, UTF-8 BOM, provenance preamble
  (title, period, published by/at, summary line, `Developed by AI/API Team /
  Simple.biz (c) YYYY`)
- `buildPayCycleReportWorkbook(model)` — title/summary banner rows, sized
  columns, autofilter over the header
- `generatePayCycleReportPdf(model)` — landscape US Letter: Simple masthead,
  eyebrow + title, at-a-glance metric band, per-processor band, paginated payee
  table with warm zebra rows, gradient rules, per-page footers
- `downloadPayCycleReportCsv` / `...Xlsx` / `...Pdf`

Columns (all three formats): `#` · Name · Email · Type · Processor ·
Amount (USD) · Amount (PHP) · Txn ID · Bank used · Date sent.

PDF text passes through the existing `sanitize()` approach — pdf-lib's Helvetica
is WinAnsi-encoded, so `₱` becomes `PHP ` and `→` becomes `->`. XLSX theming is
structural only (SheetJS community emits no fills/font colours).

## Error handling

- **List read fails** → the tab shows an inline error with a Retry; the signing
  queue tab is unaffected (separate fetch, separate state).
- **Publish fails** → the dialog stays open with the message inline; nothing is
  written. A `409` re-renders the card in its (new) not-ready state.
- **Duplicate publish** (`23505`) → treated as success-with-refresh, not an
  error: the report exists, which is what the clerk wanted.
- **Malformed / older snapshot JSON** → that report renders as an unreadable
  entry with its key and an Unpublish action, rather than blanking the tab.
  `version` mismatch is tolerated; missing optional fields fall back to `—`.
- **Export with zero payees** → buttons disabled with a title explaining why.

## Testing

- `pay-cycle-reports` unit tests: eligibility predicate (each blocking bucket in
  turn, zero-paid cycle, `urgent_*` exclusion), snapshot builder (distinct payee
  count vs dispatch count, contractor rows, per-processor tally).
- `pay-cycle-report-export` unit tests: CSV escaping/preamble, workbook shape
  (header row index, autofilter ref), PDF generation returns non-empty bytes for
  an empty and a multi-page payee list, `₱`/`→` sanitization.
- Manual: publish the current cycle, confirm it leaves `publishable` and appears
  in `published`; undo a payment in PD and confirm the published report is
  unchanged; download all three formats and open them.

## Out of scope

- No email/notification on publish. The existing `payment_cycle_complete`
  confetti webhook already fires when PD hits 100%; this button is the
  record-keeping act, not a second announcement.
- No changes to Payment Dispatch → Reports.
- No storage bucket, no stored PDF bytes.
- No cross-link from the published report back into PD's live report view
  (`cycle_id` is stored so it can be added later).
