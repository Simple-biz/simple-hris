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

## The urgent marker: `cycle_source_file`, never `cycle_id`

**File:** `src/lib/payroll/urgent-cycle.ts` — the single source of truth for bucketing urgent payouts. Writers and readers must both go through it.

An urgent `payment_dispatches` row is identified by its `cycle_source_file` starting with `urgent_`. Its `cycle_id` is **NULL**, because `cycle_id` is `UUID REFERENCES hubstaff_uploads(id)` and an urgent payment has no Hubstaff upload behind it.

> **Fixed 2026-07-29 — why this rule exists.** Both dispatch routes used to write the sentinel string `cycle_id: 'urgent'`, and `loadUrgentDispatchRows` filtered `.eq('cycle_id','urgent')`. Postgres rejected both against a `uuid` column with `22P02 invalid input syntax for type uuid: "urgent"`, so **every** urgent Send / Mark as Paid failed (MESA *and* one-off), and because the reader discarded its error the weekly Urgent report just looked empty rather than broken. Not one urgent dispatch row was ever recorded. A migration to retype the column to `text` was written but never applied; removing the sentinel fixed it with no DDL and kept the FK.

Two invariants worth keeping:

- **Every** bucket name keeps the `urgent_` prefix, including the no-date fallback (`urgent_unbucketed`). The prefix is still the contract: `buildUrgentWeeklyReports` / `loadUrgentDispatchRows` bucket urgent payouts by it, and `GET /api/urgent-payments/dispatches` serves the current week's slice — so a name without it (the old `mesa_urgent` / `oneoff_urgent`) drops the payment out of every urgent view. (The report detail view that used to open these weeks was removed 2026-08-12 with the Reports tab.)
- `_` is a single-character wildcard in SQL `LIKE`, so the server-side `like('cycle_source_file','urgent_%')` is a *prefilter*; `isUrgentSourceFile` re-checks each row exactly.

Covered by `src/lib/payroll/urgent-cycle.test.ts`.

---

## Where it lives

- **Accounting → Payment Dispatch** (`src/components/payroll-clerk/PayrollDispatch.tsx`) — the URGENT card sits **directly above Kolan** in the processor filter rail (right after "All pending"), amber/Zap themed with a pulsing glow.
- **Payroll Clerk** (`/payroll-clerk` → `PayrollClerkApp.tsx` + `PayrollClerkSidebar.tsx`) — a pre-existing "Urgent Payments" sidebar entry. Both surfaces render the same `UrgentPaymentsQueue`.
- **Reports** — weekly "Urgent · &lt;dates&gt;" cards appeared in the Reports grid on both surfaces until the Reports tab was removed (2026-08-12); the weekly summary buckets survive in `listDisbursementReports()` (see **Weekly-bucket reports**).

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

## The Urgent bucket persists all week *(2026-07-30, `5c82064`)*

Previously the URGENT card and its queue **disappeared the moment the last pending item
was paid** — so a week's urgent history was only reachable from Reports. The bucket now
behaves like every other processor bucket: it stays for the whole week and offers the same
views.

| View | Contents |
|---|---|
| **Pending** | the three pending sections above (MESA, orphanage budgets, one-offs) |
| **Paid** | dispatched cards for this week |
| **Not paid** | dispatched-but-unsettled cards |
| **Threshold** / **Problem** | the same status splits the other buckets use |

The log views are built from `GET /api/urgent-payments/dispatches`, which reads this week's
`urgent_<sun>_to_<sat>` bucket (see **The urgent marker** above) plus the synthesized
orphanage rows, through the same `loadUrgentDispatchRows` normalization the reports use — so
the bucket and the weekly report can never disagree.

### Undo on a dispatch-log card *(2026-07-30, `b2ff805`)*

Every dispatched card in Paid / Not paid / Threshold / Problem carries an **Undo** button.
It opens a confirm dialog (money-adjacent, never one-click) naming the person and amount and
stating plainly that it **deletes the logged payment and returns the request to pending** —
and does **not** reverse money already sent. On confirm the card leaves the log view and the
request reappears under Pending, ready to Send again.

**Why this needed its own route** (`POST /api/urgent-payments/dispatches/undo`): the regular
processor-queue undo just deletes the `payment_dispatches` row, because its pending queue is
*recomputed* from hours. Urgent pending items live in **source request tables**, so deleting
the dispatch row alone would leave the request stamped "dispatched" forever — not pending,
not paid, invisible. Per source:

| Source | How the request is recovered |
|---|---|
| **One-off payment** | links back via `urgent_payment_requests.dispatch_id` — flip the request to `pending`, then delete the dispatch row |
| **MESA disbursement** | **no link column exists** (Send only stamps `dispatched_at`), so the request is found from the `mesa.disbursement.dispatched` **audit event** written at Send time, with a fallback to an exact email + amount + dispatched match accepted **only when unambiguous**. If neither finds it (a legacy row) the money log is still removed but the clerk gets an explicit warning toast that nothing was restored |
| **Orphanage budget** | only the `orphanage_dispatches` row is deleted — pending is derived as "approved request with no dispatch row", so it revives itself |

Two safety choices worth preserving:

- **Revive before delete**, and the revive is a **no-op on retry** — so if the delete fails,
  the card stays visible and clicking Undo again just retries, instead of stranding an
  invisible payment.
- Every undo writes an **awaited** `payment.undone` audit event carrying the deleted row's
  full payload (same contract as the core undo route), so the record of who was paid what
  never silently disappears.

---

## Urgent filed → email alert to Accounting *(2026-07-30, `3f4240b`)*

Urgent payment requests are **only ever created by the People tab's "Pay" button**
(`POST /api/people/pay`), so that route now fires an n8n webhook best-effort right after
the request row is inserted — a webhook hiccup can never fail the payment itself
([`src/lib/people/urgent-payment-notify.ts`](../../src/lib/people/urgent-payment-notify.ts)).

The workflow emails **carla@**, **claire@** and **lennyt@simple.biz** a red-alarm alert with
who to pay, the ₱ amount, department, note, and who filed it, plus a button linking into
HRIS → Payment Dispatch → Urgent. Recipients and copy are **fixed inside the workflow's Code
node** (same pattern as `bank_info_notify`), so the endpoint can't be abused as a general
mailer.

**To go live:** import
[`references/n8n/urgent-payment-alert.workflow.json`](../../references/n8n/urgent-payment-alert.workflow.json),
attach a Gmail OAuth2 credential to *Send Urgent Alert (Gmail)*, activate, then register the
production webhook URL in **Admin → Webhooks** under slug **`urgent_payment_notify`** (env
fallback `N8N_URGENT_PAYMENT_NOTIFY_WEBHOOK_URL`). Optional lockdown: `REQUIRED_SECRET` in
the Code node + `N8N_URGENT_PAYMENT_NOTIFY_SECRET` in the HRIS env. **Until the URL is
registered the app-side fire silently no-ops**, so nothing breaks in the meantime.

---

## The dispatch route (MESA)

**File:** `app/api/mesa-requests/[id]/dispatch/route.ts` (elevated session only)

On dispatch of an approved, not-yet-dispatched disbursement:

1. **Processor:** `body.processor` validated against the known set; defaults to `wise`.
2. **Weekly bucket:** `urgentCycleSourceFile(sent_date)` → `cycle_source_file = urgent_<weekStart>_to_<weekEnd>`, with `cycle_period_start/end` set to the week bounds. `cycle_id = NULL` (see **The urgent marker** below).
3. **USD:** `amount_usd = amount_php / fx` where `fx = app_settings.usd_to_php_rate` (so the USD-centric weekly report totals include it).
4. Inserts the `payment_dispatches` row, stamps `mesa_requests.dispatched_at`, and writes an audit log (`mesa.disbursement.dispatched`) including processor + cycle_source_file.

Guards: 404 if the request is missing, 400 if not a `disbursement` or not `approved`, 409 if already dispatched.

---

## Weekly-bucket reports

**File:** `src/lib/payroll/disbursement-reports.ts`

### `loadUrgentDispatchRows(): PaymentDispatchRow[]`

Returns a single normalized list combining both sources:

- **MESA + one-off:** real `payment_dispatches` whose `cycle_source_file` starts with `urgent_` (used as-is).
- **Orphanage budgets:** paid/problem `orphanage_dispatches` of `dispatch_type = 'budget_request'`, synthesized into `PaymentDispatchRow` shape:
  - `processor = 'wires'`, `recipient_email = submitter_email`, `recipient_name = label`.
  - `amount_usd = amount_php / fx` (current FX rate); `amount_php` preserved.
  - `cycle_source_file = urgent_<week>` computed from `sent_date` (→ `paid_at` → `created_at` fallback) via the same Sun–Sat `sundayWeekRange`.

The summary builder (`buildUrgentWeeklyReports`) and `/api/urgent-payments/dispatches` both consume this loader, so the weekly buckets and the Urgent tab's Paid/Not-paid views never diverge. (The report detail table was a third consumer until the Reports tab's removal, 2026-08-12.)

### `buildUrgentWeeklyReports()`

Groups `loadUrgentDispatchRows()` by `cycle_source_file` into `DisbursementReportSummary` objects:

- `cycleId = source:<sourceFile>`, `reportName = "Urgent · <range>"`, `isCurrent = false`.
- Totals tallied by status; `byProcessor` keyed by each row's processor (orphanage budgets land under **Wires**); `paidRecipients` from paid rows.

`listDisbursementReports()` appends these (additively, in a `try/catch` so a failure can't break the regular cycle reports) before sorting newest-period-first. Their `urgent_…` source files never match a Hubstaff upload, so they don't affect the "unseeded uploads" banner.

### `getDisbursementReportDetail()` — deleted *(2026-08-12)*

The function is gone, removed with the Payment Dispatch Reports tab. The urgent weekly **summary** buckets survive inside `listDisbursementReports()` — Penny's CEO tools and the CEO financial reports consume them — but the on-screen "Urgent · &lt;week&gt;" cards and their detail view died with the tab on 2026-08-12. **Open gap:** once the current week rolls over, dispatched urgent rows are no longer visible in any UI — only Penny can see them.

---

## The URGENT rail card + glow

**File:** `src/components/payroll-clerk/PayrollDispatch.tsx` (+ `ProcessorCard.tsx`)

- A `'urgent'` tab id and `URGENT_VISUAL` (Zap, amber→orange gradient, "MESA · pay now").
- The card renders **directly above Kolan** (after "All pending") and short-circuits `renderBody()` to `<UrgentPaymentsQueue>` before the cycle-ready/loading gates (urgent bypasses the weekly cycle).
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
    → POST /api/mesa-requests/[id]/dispatch        payment_dispatches (cycle_id=NULL,
                                                    cycle_source_file=urgent_<week>, amount_usd)
                                                    + mesa_requests.dispatched_at stamped
    → listDisbursementReports ("Urgent · <week>" summary bucket)

Orphanage budget:
  approved orphanage_budget_requests (unpaid)
    → GET /api/orphanage-dispatches?pending=1     (filtered to budget_request)
    → UrgentPaymentsQueue (Budget section)        clerk → Pay wire (OrphanageMarkPaidDialog)
    → POST /api/orphanage-dispatches              orphanage_dispatches row (status=paid)
    → removed from BOTH Urgent + Orphanage queues (dedup on orphanage_dispatches existence)
    → listDisbursementReports "Urgent · <week>" summary bucket (PHP→USD, processor=Wires)
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
| `src/components/payroll-clerk/PayrollDispatch.tsx` | **Edited** — `'urgent'` tab + URGENT card above Kolan (`glowBorder`) + render branch + `urgentCount` |
| `src/components/payroll-clerk/ProcessorCard.tsx` | **Edited** — opt-in `glowBorder` pulsing amber outer glow |
| `src/components/payroll-clerk/DispatchReports.tsx` | **Edited** — removed flat urgent panel; urgent card styling; mark-all-paid hidden for urgent *(surface removed 2026-08-12)* |
| `src/lib/payroll/disbursement-reports.ts` | **Edited** — `sundayWeekRange`, `loadUrgentDispatchRows` (MESA + synthetic orphanage budgets), `buildUrgentWeeklyReports`, urgent branch in `getDisbursementReportDetail` |
| `src/lib/payroll/dispatch-export-csv.ts` | **Edited** — `buildDispatchExportRowsFromDispatches` fallback for record-less (urgent) reports *(file deleted 2026-08-12 with the Reports tab)* |
| `app/api/payment-dispatches/reports/[cycleId]/export/route.ts` | **Edited** — uses the dispatches-only export builder when there are no `disbursement_records` *(surface removed 2026-08-12)* |
| `references/add_mesa_dispatched_at.sql` | **Prereq** — `mesa_requests.dispatched_at` + urgent-queue index |
