# Urgent Payments

> **Status:** Implemented 2026-06-04. Extends the MESA scaffolding (queue + dispatch route) that pre-existed; adds per-recipient processor selection, the URGENT card in the accounting Payment Dispatch rail, weekly-bucket reports, and orphanage **budget requests** as a second urgent source.

Urgent payments are non-weekly payouts that must be sent **immediately upon approval** and bypass the regular weekly Payroll Wizard cycle, then reconcile into a weekly report. Per the Carla/Kentshin meeting (`docs/meetings/meeting-with-carla-and-kentshin2.md` §4.1), urgent payments cover **MESA account disbursements** (e.g. medical emergencies) **and orphanage budget requests**.

**Key design decisions:**

- **Two urgent sources, two payment mechanisms.** MESA disbursements pay a single employee via their chosen processor and persist to `payment_dispatches`. Orphanage budget requests pay by **wire to a fixed orphanage bank account** and persist to `orphanage_dispatches` (the existing orphanage mechanism). They share one queue but keep their own rails.
- **Per-recipient processor (MESA).** MESA is no longer hardcoded to Wise. Each card defaults to the recipient's saved `preferred_processor` (else Wise) and the clerk can change it per card; a processor filter rail narrows the MESA list.
- **Weekly Sun–Sat reconciliation.** Every urgent payout is bucketed into the Sun→Sat week it was sent — matching the regular Hubstaff cycles (e.g. `2026-04-12_to_2026-04-18` = Sun–Sat) — and surfaces as an "Urgent · &lt;dates&gt;" report card alongside the regular weekly reports.
- **Budget requests appear in two tabs, no double-pay.** A pending budget request shows in both the **Urgent** tab and the **Orphanage** tab. Paying it in either place creates an `orphanage_dispatches` row, and both queues dedup on the existence of that row, so it disappears from both. There is no double-pay risk.
- **No `disbursement_records` for urgent.** Weekly urgent reports are synthesized live from `payment_dispatches` + `orphanage_dispatches`, never seeded into `disbursement_records` — so no schema pollution and no unique-key collision with the hours-based payroll reports.

---

## Where it lives

- **Accounting → Payment Dispatch** (`src/components/payroll-clerk/PayrollDispatch.tsx`) — the URGENT card sits **directly above Hurupay** in the processor filter rail (right after "All pending"), amber/Zap themed with a pulsing glow.
- **Payroll Clerk** (`/payroll-clerk` → `PayrollClerkApp.tsx` + `PayrollClerkSidebar.tsx`) — a pre-existing "Urgent Payments" sidebar entry. Both surfaces render the same `UrgentPaymentsQueue`.
- **Reports** — weekly "Urgent · &lt;dates&gt;" cards appear in the Reports grid on both surfaces.

---

## Prerequisites (Supabase migrations)

| Migration | Purpose |
|---|---|
| `references/add_mesa_requests.sql` | Creates `mesa_requests` (MESA opt-in/out/disbursement/return). |
| `references/add_mesa_dispatched_at.sql` | Adds `mesa_requests.dispatched_at` + the urgent-queue index. |

No new migration is needed for the orphanage budget-request integration — it reuses the existing `orphanage_budget_requests` and `orphanage_dispatches` tables. The weekly report's PHP→USD conversion reads `app_settings.usd_to_php_rate`.

---

## The Urgent queue

**File:** `src/components/payroll-clerk/UrgentPaymentsQueue.tsx`

On mount it fetches both sources in parallel and renders two sections. `onCountChange(MESA + budget)` drives the rail badge.

### Section 1 — MESA Disbursements

- **Source:** `GET /api/urgent-payments` — approved, not-yet-dispatched `mesa_requests` of type `disbursement`. Each row carries the recipient's `processor` (preferred, else `wise`) and a full `details` object (per-processor payout fields) so the Mark Paid dialog pre-fills for whichever processor is chosen.
- **Processor filter rail:** chips for "All" + each processor present in the queue (counted by the chosen processor). Filtering narrows the MESA cards only.
- **Per-card processor `<select>`:** defaults to the recipient's preferred processor; the clerk can override per card. The chosen processor drives the `MarkPaidDialog` defaults and the dispatch record.
- **Send →** opens the standard `MarkPaidDialog` (processor-aware) → on confirm, `POST /api/mesa-requests/[id]/dispatch`.

### Section 2 — Orphanage Budget Requests

- **Source:** `GET /api/orphanage-dispatches?pending=1`, filtered to `sourceType === 'budget_request'` (gift purchases are **not** urgent).
- **Cards:** wire-style (teal accent inside the amber tab), showing the orphanage bank summary. There is **no processor selector** — these are wires to the orphanage's fixed account.
- **Pay wire →** opens the shared `OrphanageMarkPaidDialog` → on confirm, `POST /api/orphanage-dispatches` (creates an `orphanage_dispatches` row, exactly like the Orphanage tab).

`OrphanageMarkPaidDialog` was extracted from `OrphanageQueue.tsx` into its own file (`src/components/payroll-clerk/OrphanageMarkPaidDialog.tsx`) so the Orphanage tab and the Urgent queue share one implementation.

### Section 3 — One-off Payments

- **Source:** `GET /api/urgent-payments/requests` — `pending` `urgent_payment_requests`, filed by the People tab's "Pay" action. Enriched with the same preferred-processor + `details` pre-fill as MESA.
- **Send →** the shared `MarkPaidDialog` → `POST /api/urgent-payments/requests/[id]/dispatch`.

### Amounts on the cards

Both feeds return **`amount_usd`** alongside the filed peso figure, converted server-side by `usdFromPhp(amount, fetchUsdToPhpRate(...))` (`src/lib/payroll/urgent-payout-details.ts`) — the *same* conversion the dispatch routes persist onto `payment_dispatches.amount_usd`, so the number the clerk approves is the number that lands in the weekly report. Cards headline the **USD equivalent** with the peso amount beneath it, matching the rest of the dispatch queue, and fall back to peso-only if the conversion is unavailable. The USD figure also rides into `MarkPaidDialog` as `amountUSD`, so its secondary line shows dollars instead of a dash.

### Removing an item (delete)

Each MESA and one-off card carries a trash button that opens a confirm dialog before anything happens. The two sources use their own sanctioned removal path:

| Source | Endpoint | Effect |
|---|---|---|
| MESA disbursement | `DELETE /api/mesa-requests/[id]` | Hard-deletes the request. Refuses (409) anything with `dispatched_at` set. Requires `mesa` **edit** (MESA's own gate), audit-logged as `mesa.request.deleted`. |
| One-off payment | `DELETE /api/urgent-payments/requests/[id]` | Flips `status` `pending`→`cancelled`, conditionally on it still being `pending` — so an item paid by a concurrent Send can never be removed (409). Requires `payment_dispatch` **edit**, audit-logged as `urgent_payment.cancelled`. |

One-off payments cancel rather than delete because their table's `status` CHECK carries `'cancelled'` for exactly this, and People-tab "Pay" is a money action whose paper trail should outlive the queue card. Either way the card leaves the queue, since both feeds select only pending rows.

Orphanage budget requests have **no** remove button: they are approved records owned by the Orphanage module's own workflow, so they are withdrawn there, not from a payments screen.

---

## The dispatch route (MESA)

**File:** `app/api/mesa-requests/[id]/dispatch/route.ts` (elevated session only)

On dispatch of an approved, not-yet-dispatched disbursement:

1. **Processor:** `body.processor` validated against the known set; defaults to `wise`.
2. **Weekly bucket:** `sundayWeekRange(sent_date)` → `cycle_source_file = urgent_<weekStart>_to_<weekEnd>`, with `cycle_period_start/end` set to the week bounds. `cycle_id = 'urgent'`.
3. **USD:** `amount_usd = amount_php / fx` where `fx = app_settings.usd_to_php_rate` (so the USD-centric weekly report totals include it).
4. Inserts the `payment_dispatches` row, stamps `mesa_requests.dispatched_at`, and writes an audit log (`mesa.disbursement.dispatched`) including processor + cycle_source_file.

Guards: 404 if the request is missing, 400 if not a `disbursement` or not `approved`, 409 if already dispatched.

---

## Weekly-bucket reports

**File:** `src/lib/payroll/disbursement-reports.ts`

### `loadUrgentDispatchRows(): PaymentDispatchRow[]`

Returns a single normalized list combining both sources:

- **MESA:** real `payment_dispatches` where `cycle_id = 'urgent'` (used as-is).
- **Orphanage budgets:** paid/problem `orphanage_dispatches` of `dispatch_type = 'budget_request'`, synthesized into `PaymentDispatchRow` shape:
  - `processor = 'wires'`, `recipient_email = submitter_email`, `recipient_name = label`.
  - `amount_usd = amount_php / fx` (current FX rate); `amount_php` preserved.
  - `cycle_source_file = urgent_<week>` computed from `sent_date` (→ `paid_at` → `created_at` fallback) via the same Sun–Sat `sundayWeekRange`.

Both the summary builder and the detail view consume this loader, so summary totals and the detail table never diverge.

### `buildUrgentWeeklyReports()`

Groups `loadUrgentDispatchRows()` by `cycle_source_file` into `DisbursementReportSummary` objects:

- `cycleId = source:<sourceFile>`, `reportName = "Urgent · <range>"`, `isCurrent = false`.
- Totals tallied by status; `byProcessor` keyed by each row's processor (orphanage budgets land under **Wires**); `paidRecipients` from paid rows.

`listDisbursementReports()` appends these (additively, in a `try/catch` so a failure can't break the regular cycle reports) before sorting newest-period-first. Their `urgent_…` source files never match a Hubstaff upload, so they don't affect the "unseeded uploads" banner.

### `getDisbursementReportDetail()`

When `summary.sourceFile` starts with `urgent_`, the detail's `dispatches` come from `loadUrgentDispatchRows()` filtered to that week (no `disbursement_records`, so `outstanding = []`).

### Reports UI

**File:** `src/components/payroll-clerk/DispatchReports.tsx`

- The old flat "Urgent MESA disbursements" panel was **removed** — weekly cards replace it.
- Cards whose `sourceFile` starts with `urgent_` get a **Zap icon + amber** treatment and an "Urgent" badge.
- **Mark-all-paid is hidden** for urgent reports (it targets `disbursement_records`, which urgent rows don't have).
- CSV export: the `[cycleId]/export` route falls back to `buildDispatchExportRowsFromDispatches(report.dispatches, rates)` when there are no `disbursement_records` (i.e. urgent reports), so the export still lists every urgent payout.

> Paid budget requests therefore appear in **two** places in Reports: the existing **Orphanage Payments** panel (budgets + gifts) and the weekly **Urgent** card (MESA + budgets). This duplication is intentional ("weekly urgent report too").

---

## The URGENT rail card + glow

**File:** `src/components/payroll-clerk/PayrollDispatch.tsx` (+ `ProcessorCard.tsx`)

- A `'urgent'` tab id and `URGENT_VISUAL` (Zap, amber→orange gradient, "MESA · pay now").
- The card renders **directly above Hurupay** (after "All pending") and short-circuits `renderBody()` to `<UrgentPaymentsQueue>` before the cycle-ready/loading gates (urgent bypasses the weekly cycle).
- **Glowing outer border:** `ProcessorCard` gained an opt-in `glowBorder` prop — a slow (2s) amber box-shadow pulse via `motion`'s `animate`, plus an amber border. The glow is a box-shadow on the button itself, so it renders **outside** the card's `overflow-hidden` clip. Only the URGENT card sets `glowBorder`.
- The badge count (`urgentCount`) is lazy — it populates the first time the tab is opened (same as the `/payroll-clerk` sidebar); the glow flags the card regardless.

---

## Data flow end-to-end

```
MESA:
  employee → mesa_requests (disbursement, pending)
    → accounting approves (AccountingMesa)        status=approved, dispatched_at=null
    → GET /api/urgent-payments                    (+ preferred processor + details)
    → UrgentPaymentsQueue (MESA section)          clerk picks processor → Send
    → POST /api/mesa-requests/[id]/dispatch        payment_dispatches (cycle_id=urgent,
                                                    cycle_source_file=urgent_<week>, amount_usd)
                                                    + mesa_requests.dispatched_at stamped
    → listDisbursementReports → "Urgent · <week>" report card

Orphanage budget:
  approved orphanage_budget_requests (unpaid)
    → GET /api/orphanage-dispatches?pending=1     (filtered to budget_request)
    → UrgentPaymentsQueue (Budget section)        clerk → Pay wire (OrphanageMarkPaidDialog)
    → POST /api/orphanage-dispatches              orphanage_dispatches row (status=paid)
    → removed from BOTH Urgent + Orphanage queues (dedup on orphanage_dispatches existence)
    → Orphanage Payments panel  AND  "Urgent · <week>" report card (PHP→USD, processor=Wires)
```

---

## Authorization

| Action | Gate |
|---|---|
| List urgent MESA (`GET /api/urgent-payments`) | Elevated session (`requireElevatedSession`) |
| Dispatch MESA (`POST /api/mesa-requests/[id]/dispatch`) | Elevated session; row must be `disbursement` + `approved` + not dispatched |
| List pending orphanage budgets (`GET /api/orphanage-dispatches?pending=1`) | Existing orphanage-dispatches route auth |
| Pay orphanage budget (`POST /api/orphanage-dispatches`) | Existing orphanage-dispatches route auth |

---

## Employee MESA weekly contribution (client-only)

> The accounting-side urgent dispatch above pays out **approved** MESA disbursements. Separately, the **employee MESA tab** (`src/components/employee/EmployeeMesa.tsx`) shows the recurring weekly savings/match shape. These are client-side constants and copy only — **no DB, schema, or API change.**

The weekly contribution is **employee ₱100 + company (Simple.biz) ₱300 = ₱400 per week** (`EmployeeMesa.tsx:45-47`):

| Constant | Value | Drives |
|---|---|---|
| `WEEKLY_EMPLOYEE_CONTRIB` | `100` | the per-week employee deduction |
| `WEEKLY_COMPANY_MATCH` | `300` | the "We contribute" / "Simple.biz has matched" cards, the per-week ledger row, and `cumulativeCompany = completed.length * WEEKLY_COMPANY_MATCH` |
| `WEEKLY_TOTAL` | `400` (`100 + 300`) | the combined weekly total |

The company match was **lowered from ₱400 to ₱300** (weekly total previously ₱500, now ₱400). The matching narrative now reads **"matched three times over"** (3× the employee's ₱100), and the opt-in agreement text reads **"PHP 300 each week"** — both updated in lockstep with the constant.

---

## Files changed / created

| Path | Change |
|---|---|
| `app/api/urgent-payments/route.ts` | **Edited** — returns each recipient's preferred `processor` + full `details` (per-processor payout fields) |
| `app/api/mesa-requests/[id]/dispatch/route.ts` | **Edited** — accepts `processor`; weekly `cycle_source_file` + period bounds; `amount_usd` from FX; richer audit log |
| `src/components/payroll-clerk/UrgentPaymentsQueue.tsx` | **Edited** — two sections (MESA + orphanage budgets); per-card processor select + filter rail; orphanage wire cards; count = MESA + budget |
| `src/components/payroll-clerk/OrphanageMarkPaidDialog.tsx` | **New** — extracted from `OrphanageQueue.tsx`; shared by the Orphanage tab and the Urgent queue |
| `src/components/payroll-clerk/OrphanageQueue.tsx` | **Edited** — imports the extracted dialog; dropped the inlined copy |
| `src/components/payroll-clerk/PayrollDispatch.tsx` | **Edited** — `'urgent'` tab + URGENT card above Hurupay (`glowBorder`) + render branch + `urgentCount` |
| `src/components/payroll-clerk/ProcessorCard.tsx` | **Edited** — opt-in `glowBorder` pulsing amber outer glow |
| `src/components/payroll-clerk/DispatchReports.tsx` | **Edited** — removed flat urgent panel; urgent card styling; mark-all-paid hidden for urgent |
| `src/lib/payroll/disbursement-reports.ts` | **Edited** — `sundayWeekRange`, `loadUrgentDispatchRows` (MESA + synthetic orphanage budgets), `buildUrgentWeeklyReports`, urgent branch in `getDisbursementReportDetail` |
| `src/lib/payroll/dispatch-export-csv.ts` | **Edited** — `buildDispatchExportRowsFromDispatches` fallback for record-less (urgent) reports |
| `app/api/payment-dispatches/reports/[cycleId]/export/route.ts` | **Edited** — uses the dispatches-only export builder when there are no `disbursement_records` |
| `references/add_mesa_dispatched_at.sql` | **Prereq** — `mesa_requests.dispatched_at` + urgent-queue index |
