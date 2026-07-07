# MESA (Medical Emergency Savings Account)

> **Status:** Requests flow shipped 2026-06-01; contribution ledger backfilled + surfaced 2026-06-26. This doc covers the whole feature. For the accounting-side payout mechanics (Urgent Payments queue, weekly Sun–Sat reconciliation) see [urgent-payments.md](urgent-payments.md); for the underlying tables see [data-sources.md §10 (`mesa_requests`) and §15 (`mesa_ledger`)](../reference/data-sources.md).

MESA is an **employee savings / contribution program** framed as a *Medical Emergency Savings Account*. Enrolled members have **₱100 deducted from their paycheck each week**, which Simple.biz **matches three times over (+₱300)** — so the account grows by **₱400/week**. Funds are meant for infrequent emergencies: medical needs for the member or immediate family (spouse + children only), natural disasters, or a necessary primary-computer repair. Program rules (from the About tab): one disbursement per 90 days, receipts within 14 days / 30 calendar days, and temporary removal for non-compliance.

The **only way to join is to complete a Financial Peace University (FPU) class**, then submit an Opt-in request.

Contribution amounts are single-sourced in `EmployeeMesa.tsx`:

| Constant | Value |
|---|---|
| `WEEKLY_EMPLOYEE_CONTRIB` | `100` |
| `WEEKLY_COMPANY_MATCH` | `300` |
| `WEEKLY_TOTAL` | `400` |

---

## The two data sources

MESA is backed by a **request queue** and a **contribution ledger** — they are separate concerns.

- **`mesa_requests`** — employee-submitted opt-in / opt-out / disbursement / return requests, plus their review + dispatch state. This is the *workflow* table.
- **`mesa_ledger`** — a faithful 1:1 backfill of the external MESA program tracker (~7,235 event rows, 295 members). Each row is one event: a weekly deposit, a disbursement, or a status snapshot. This is the *historical record* of money in/out. The app never mutates it; it is imported once.

See [data-sources.md](../reference/data-sources.md) for full column shapes.

### The ledger backfill (why it's loaded "another way")

The DDL (`references/sql/create/mesa_ledger_ddl.sql`) is small and pastes into the Supabase SQL Editor fine. The **data backfill (`references/sql/create/backfill_mesa_ledger.sql`) is too large** — the SQL Editor rejects it as "query too large." It is instead loaded by **`scripts/load-mesa-ledger.mjs`**, which parses the file's `INSERT … VALUES` tuples and upserts them over the Supabase REST API (service-role key) in batches of 500. Idempotent (`upsert onConflict: id`); `--dry` parses without writing. Run the DDL once first.

Aggregation is centralized in **`src/lib/mesa/ledger.ts`** (imported by both the API route and the client views, so it stays free of server-only / `'use client'` imports): `summarizeMember()` rolls a member's events into contributed / matched / deposited / disbursed / **balance (= deposited − disbursed)** with deposit & disbursement counts, first/last dates, and latest status → `isActive`.

---

## The request flow (`mesa_requests`)

Employees submit from the **Employee → MESA → Request** tab (`src/components/employee/EmployeeMesa.tsx`, `POST /api/mesa-requests`). Four request types, each with its own form section:

| Type | What it does | Reviewed by |
|---|---|---|
| `opt_in` | Join MESA after FPU. Requires all agreement checkboxes + an FPU completion date. | **HR** |
| `opt_out` | Leave the program (stops the weekly deduction + match). | **Accounting** |
| `disbursement` | Withdraw funds for an emergency. Requires a reason (Medical Emergency / Natural Disaster / Computer Repair / Other), a ≤250-char explanation, and a PHP amount. | **Accounting** |
| `return` | Return funds to the account (optional notes). | **Accounting** |

**Routing:** opt-in goes to HR because FPU/enrollment is HR's domain; the money-related types go to Accounting.

### Accounting tab — `AccountingMesa.tsx`

`src/components/payroll/AccountingMesa.tsx` (Accounting → MESA) has two views:

- **Requests** — the review queue for `opt_out` / `disbursement` / `return` (opt-in is filtered out; that's HR's). Search + status/type filters, paginated (15/page), stat cards (Total / Pending / Approved / Denied). Each pending row → **Review** modal to Approve/Deny with a note. Reviewed rows can be **revoked** (back to pending) or **deleted** — both blocked once `dispatched_at` is set (the money is already sent).
- **Member Balances** — the ledger rollup (below).

Reviews go through `PATCH /api/mesa-requests/[id]` (`requireFeatureEditAnyView('mesa')`). Approving an `opt_out` also fires `POST /api/toggle-mesa-member` with `mesaMember: false` to stop the deduction; revoking re-enrolls.

### HR tab — `HrMesa.tsx`

`src/components/hr/HrMesa.tsx` (HR → MESA) has an **Eligible** sub-tab, a **Requests** sub-tab (opt-in queue, `?request_type=opt_in`), and an **FPU** sub-tab. Approving an opt-in fires `POST /api/toggle-mesa-member` with `mesaMember: true`, enrolling the member so the Wizard begins the weekly deduction.

---

## How contributions surface

All three dashboards read the same ledger via `GET /api/mesa-ledger` and render with `src/lib/mesa/ledger.ts` types.

### Accounting — Member Balances

`AccountingMesa.tsx` → Member Balances view. Program-wide per-member table (`GET /api/mesa-ledger`, no `?email=` → `requireElevatedSession`): Contributed / Matched / Disbursed / Balance / Active status, with summary cards for the totals. Searchable, paginated (20/page). Each row has a **View** button opening a drill-down modal (`MesaMemberDetail`) that fetches `/api/mesa-ledger?email=` and shows the member's **full timeline of deposits + disbursements with dates**, their totals, and first/last deposit + last disbursement dates.

### HR — Eligible list

`HrMesa.tsx` → Eligible sub-tab. Joins the roster to the ledger by email (`GET /api/mesa-ledger`), surfacing each employee's contribution rollup (`MesaMemberSummary`, `null` when there's no ledger history).

### Employee — MESA History

`EmployeeMesa.tsx` → History sub-tab. Calls `GET /api/mesa-ledger?email=` (self-scoped via `authorizeEmailAccess`). When real ledger data exists it wins (`RealMesaHistory`): a hero with the member's actual Contributed / Matched / Balance, then a **week-by-week ledger of deposits & disbursements** in a **fixed-height scroll region (~740px, roughly 20 rows) with a search box and no pagination** — all matching rows render inside the scroller. If the member has no ledger rows yet, the tab falls back to a **projected** weekly ledger computed from the enrollment date (`mesa_member_since`, else hire date) at ₱100 + ₱300/week, excluding the in-progress week — clearly labeled as a projection.

---

## The Payroll Wizard deduction

The Wizard (`src/components/PayrollWizard.tsx`) drives MESA money into pay via the Additions **"MESA"** column, using two inputs:

1. **Weekly deduction (−₱100).** Applied automatically to members whose rates row has `mesa_member = true`, but only for weeks on/after `mesa_member_since` (both dates are `YYYY-MM-DD`, compared lexically against the week end). This flag is set by `POST /api/toggle-mesa-member` (from HR opt-in approval) and preloaded from the ledger by `scripts/preload-mesa-membership.mjs`.
2. **Disbursement (+PHP).** Approved, not-yet-dispatched `disbursement` requests (`GET /api/mesa-requests?request_type=disbursement&status=approved`) are folded in per employee. A disbursement also implies an active member, so it forces the −₱100 that week.

Net effect on Final pay: `finalPay = initialPay + bonuses − mesaDeduction + mesaDisbursement + orphanagePay`. The `mesa_deduction` / `mesa_disbursement` breakdown is carried on the paystub payload so the Employee dashboard can itemize the weekly ₱100.

---

## Disbursement payout (cross-reference)

Approving a disbursement in Accounting is a *signal*, not a payment. The actual payout happens through the **Urgent Payments** queue: MESA disbursements are surfaced as **URGENT** (alongside orphanage budget requests) and bucketed into **Sun–Sat weekly reports**, with per-recipient processor selection. Paying one fires `POST /api/mesa-requests/[id]/dispatch`, which stamps `dispatched_at` and writes the `payment_dispatches` row. Full mechanics — the URGENT rail card, weekly-bucket reports, and the shared queue — live in [urgent-payments.md](urgent-payments.md); this doc does not duplicate them.

---

## Authorization

| Action | Gate |
|---|---|
| Submit a request (`POST /api/mesa-requests`) | Self (`authorizeEmailAccess` on `work_email`) |
| List own requests / own ledger (`?email=`) | Self (`authorizeEmailAccess`) |
| List all requests / program-wide balances | `requireElevatedSession` |
| Approve / deny / revoke / delete a request | `requireFeatureEditAnyView('mesa')` |
| Dispatch an approved disbursement | Elevated session (see urgent-payments.md) |

---

## Key files

| Path | Role |
|---|---|
| `src/components/employee/EmployeeMesa.tsx` | Employee About / Request / History tabs |
| `src/components/payroll/AccountingMesa.tsx` | Accounting Requests queue + Member Balances + View drill-down |
| `src/components/hr/HrMesa.tsx` | HR Eligible / opt-in Requests / FPU tabs |
| `src/components/PayrollWizard.tsx` | Weekly deduction + disbursement folded into Final pay |
| `src/lib/mesa/ledger.ts` | Shared ledger types + `summarizeMember` / `summarizeMembers` |
| `app/api/mesa-requests/route.ts` | GET (list/own) + POST (submit) |
| `app/api/mesa-requests/[id]/route.ts` | PATCH (approve/deny/revoke) + DELETE |
| `app/api/mesa-requests/[id]/dispatch/route.ts` | Pay out an approved disbursement |
| `app/api/mesa-ledger/route.ts` | Per-member or program-wide contribution rollup |
| `references/sql/create/mesa_ledger_ddl.sql` | Ledger table DDL |
| `references/sql/create/backfill_mesa_ledger.sql` | Ledger data backfill (loaded via script, not SQL Editor) |
| `references/sql/create/add_mesa_requests.sql` | `mesa_requests` table |
| `references/sql/alter/add_mesa_dispatched_at.sql` | `mesa_requests.dispatched_at` + urgent-queue index |
| `scripts/load-mesa-ledger.mjs` | Batched REST upsert of the ledger backfill |
| `scripts/preload-mesa-membership.mjs` | Seeds `mesa_member` / `mesa_member_since` from the ledger |
