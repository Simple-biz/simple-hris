# MESA (Medical Emergency Savings Account)

> **Status:** Requests flow shipped 2026-06-01; contribution ledger backfilled + surfaced 2026-06-26; roster-grounded Non Members (never-joined: not opted in, no start date) / Active Members tabs with bulk Opt In/Out + Requests bulk review, the temporary manual-enrollment bridge, an Active-sheet membership seed, and the `mesa_notes` internal notes log shipped 2026-07-16. **Per-stint MESA accounts** (`mesa_accounts` + `YY-MM-#####` account numbers, opt-out closes/zeroes the account, re-opt-in opens a fresh one) also shipped 2026-07-16 — run `references/sql/migrate/2026-07-16_mesa_accounts.sql` then `node scripts/seed-mesa-accounts.mjs --apply`. Weekly Hubstaff-upload ledger deposits shipped 2026-07-20; the week-delete cascade (deposits + notifications reversed) and the date-only timezone fix shipped 2026-07-25. This doc covers the whole feature. For the accounting-side payout mechanics (Urgent Payments queue, weekly Sun–Sat reconciliation) see [urgent-payments.md](urgent-payments.md); for the underlying tables see [data-sources.md §10 (`mesa_requests`) and §15 (`mesa_ledger`)](../reference/data-sources.md).

MESA is an **employee savings / contribution program** framed as a *Medical Emergency Savings Account*. Enrolled members have **₱100 deducted from their paycheck each week**, which Simple.biz **matches three times over (+₱300)** — so the account grows by **₱400/week**. Funds are meant for infrequent emergencies: medical needs for the member or immediate family (spouse + children only), natural disasters, or a necessary primary-computer repair. Program rules (from the About tab): one disbursement per 90 days, receipts within 14 days / 30 calendar days, and temporary removal for non-compliance.

The **only way to join is to complete a Financial Peace University (FPU) class**, then submit an Opt-in request.

Contribution amounts are single-sourced in `EmployeeMesa.tsx`:

| Constant | Value |
|---|---|
| `WEEKLY_EMPLOYEE_CONTRIB` | `100` |
| `WEEKLY_COMPANY_MATCH` | `300` |
| `WEEKLY_TOTAL` | `400` |

---

## The four data sources

MESA is backed by a **request queue**, a **contribution ledger**, an **account registry**, and an **internal notes log** — four separate concerns.

- **`mesa_requests`** — employee-submitted opt-in / opt-out / disbursement / return requests, plus their review + dispatch state. This is the *workflow* table.
- **`mesa_ledger`** — a faithful 1:1 mirror of the external MESA program tracker (originally backfilled 2026-06-26 with ~7,235 event rows; reloaded from the 2026-07-16 Active-sheet export to 8,076 rows). Each row is one event: a weekly deposit, a disbursement, or a status snapshot. This is the *historical record* of money in/out. It is **refreshed from sheet exports** (see "Refreshing the ledger" below); since 2026-07-20 the app also **appends** one ₱100+₱300 deposit row per opted-in member when a payroll week's Hubstaff hours land, and (since 2026-07-25) **removes** exactly those rows again if that week is deleted — see "Weekly deposits from the Hubstaff upload" below. The app never touches sheet-backfilled rows. Two of its columns, `notes` / `additional_notes`, are frozen free text carried over from the tracker — read-only, surfaced (when present) inline on the Accounting View drill-down's Timeline tab.
- **`mesa_accounts`** (`references/sql/migrate/2026-07-16_mesa_accounts.sql`) — one row per **enrollment stint**, each with a unique **account number `YY-MM-#####`** (opening year+month + per-month serial, e.g. `26-07-00001`). Opting out **closes** the open account (`closed_on`) — it is settled/"zeroed"; opting back in opens a **new** account with a **new** number. The member's current account number is also denormalized onto `employee_hourly_rates.mesa_account_number` (same pattern as `mesa_member`) so it flows through the existing rates plumbing. Backfilled by `scripts/seed-mesa-accounts.mjs` (stints derived from ledger termination events — an `Inactive` status row or an `Opt-out`/`Termination` disbursement, resolved per sheet member id so re-issued/concurrent ids don't split an account).
- **`mesa_notes`** (`references/sql/create/create_mesa_notes.sql`) — an ongoing, append-only internal annotation log per member, added via `POST /api/mesa-notes` from the View drill-down's Notes tab. Unlike the ledger's frozen notes, this is a live, growing log with no historical backfill.

See [data-sources.md](../reference/data-sources.md) for full column shapes.

### The ledger backfill (why it's loaded "another way")

The DDL (`references/sql/create/mesa_ledger_ddl.sql`) is small and pastes into the Supabase SQL Editor fine. The **data backfill (`references/sql/create/backfill_mesa_ledger.sql`) is too large** — the SQL Editor rejects it as "query too large." It is instead loaded by **`scripts/load-mesa-ledger.mjs`**, which parses the file's `INSERT … VALUES` tuples and upserts them over the Supabase REST API (service-role key) in batches of 500. Idempotent (`upsert onConflict: id`); `--dry` parses without writing. Run the DDL once first.

### Refreshing the ledger (ongoing)

The tracker sheet keeps accruing weekly deposit rows, so the mirror goes stale (the 2026-06-26 backfill froze the tab at 1 contribution week for everyone). To refresh, export the sheet's Active tab as CSV and run **`scripts/load-mesa-ledger-from-csv.mjs "<export>.csv" --apply`** (dry-run without the flag). It re-mirrors the table with `id` = export row order, then **re-appends any DB-only money history the export no longer carries** — the Active tab drops old disbursement rows over time (the 2026-07-16 export kept only 4 of 128; the other 124, ~₱995k, would otherwise vanish and inflate balances). The 2026-07-16 refresh is also captured as `references/sql/migrate/2026-07-16_reload_mesa_ledger_from_active_sheet.sql` (Section 1 = sheet rows, Section 2 = preserved history) — but at ~1.7 MB the SQL Editor likely rejects the paste, so the script is the practical path.

Aggregation is centralized in **`src/lib/mesa/ledger.ts`** (imported by both the API route and the client views, so it stays free of server-only / `'use client'` imports): `summarizeMember()` rolls a member's events into contributed / matched / deposited / disbursed / **balance (= deposited − disbursed)** with deposit & disbursement counts, first/last dates, and latest status → `isActive`.

**Account scoping:** when a member has an OPEN `mesa_accounts` row, `/api/mesa-ledger` returns `summarizeMemberAccount()` instead — the same rollup restricted to events dated **on/after the account's `opened_on`** (undated snapshot rows sort as `''` and never leak in). So an opt-out zeroes the visible balance (the closed account keeps its history in the ledger but no longer feeds the figures), and a re-joined member restarts from ₱0 accruing only the latest values under their new account number. The summary then carries `accountNumber` / `accountOpenedOn`. Members with no open account (ex-members, or before the migration/seed have run) keep the full-history rollup with no account number — nothing breaks on deploy order.

---

## The request flow (`mesa_requests`)

Employees submit from the **Employee → MESA → Request** tab (`src/components/employee/EmployeeMesa.tsx`, `POST /api/mesa-requests`). Four request types, each with its own form section:

| Type | What it does | Reviewed by |
|---|---|---|
| `opt_in` | Join MESA after FPU. Requires all agreement checkboxes + an FPU completion date. | **HR** |
| `opt_out` | Leave the program (stops the weekly deduction + match). Requires an **effective date** (`effective_date`, defaults to today, can't be back-dated) — no confirmation checkbox: choosing the tab and submitting *is* the request. | **Accounting** |
| `disbursement` | Withdraw funds for an emergency. Requires a reason (Medical Emergency / Natural Disaster / Computer Repair / Other), a ≤250-char explanation, and a PHP amount. | **Accounting** |
| `return` | Return funds to the account (optional notes). | **Accounting** |

**Routing:** opt-in goes to HR because FPU/enrollment is HR's domain; the money-related types go to Accounting.

### Global Master List is the source of truth

Every MESA tab is gated on the active roster (`GET /api/employees` = `active_employees`, the Global Master List minus offboarded people). The Non Members / Active Members / Eligible lists are built *from* the roster; the request queues (Accounting Requests, HR Opt-In) and the FPU sign-ups list are raw `mesa_requests` / form rows filtered against the roster's email set — work, personal, and both alternate work emails (`src/lib/roster/roster-emails.ts`). Rows for people who fall off the roster are **hidden, not deleted**: they reappear if the person is restored (relevant given the master-list sync race — see `memory/master-list-sync-race.md`). Each gated list shows an amber **"N hidden — not on the Global Master List"** note whenever the gate dropped rows, so a silent disappearance (offboard, sync race, or a mistyped FPU form email) is always visible to the reviewer. Payment flows (Urgent Payments queue, Payroll Wizard, dispatch) are deliberately *not* roster-gated so an approved payout can't silently vanish mid-flight.

### Accounting tab — `AccountingMesa.tsx`

`src/components/payroll/AccountingMesa.tsx` (Accounting → MESA) has three views:

- **Requests** — the review queue for `opt_out` / `disbursement` / `return` (opt-in is filtered out; that's HR's). Search + status/type filters, paginated (15/page), stat cards (Total / Pending / Approved / Denied). Each pending row → **Review** modal to Approve/Deny with a note. Reviewed rows can be **revoked** (back to pending) or **deleted** — both blocked once `dispatched_at` is set (the money is already sent). **Bulk**: select rows → bulk Approve / Deny (pending only; approving an `opt_out` also unenrolls) / Delete (skips dispatched).
  - **Balance impact panel** (`MesaBalanceImpact`) — the Review modal shows the member's MESA account state next to what they're asking for, so a disbursement is never approved blind: **Current balance** → **− this request** → **Balance after payout**, plus a Contributed / Matched / Disbursed footer and the account number. Fetches `GET /api/mesa-ledger?email=<work_email>&events=0` on open (elevated session reads any member; the route resolves pre-drift email aliases), so the balance is scoped to the member's **open account** and matches the MESA Active Members tab. An `opt_out` draws the **whole** balance (after = ₱0). A `return` is an inflow with no amount on the row, so only the balance is shown. Caveats surfaced inline: the request **exceeding the balance** (rose panel + shortfall), the member's **other unpaid disbursement requests** (pending or approved-but-undispatched — those aren't in the ledger yet, so they're flagged rather than subtracted), no ledger history, a failed ledger fetch, and a legacy row with no amount recorded.
- **Non Members** — employees who have **never joined** MESA: `mesa_member = false` **and** `mesa_member_since` is null. Opted-out ex-members keep their start date (`toggle-mesa-member` leaves it in place), so they are **excluded** here — they're former members, still visible via the ledger/requests, and don't appear on either the Non Members or Active Members tab. Each row has **View** + **Opt In**; **bulk Opt In** via row checkboxes. Calls `POST /api/toggle-mesa-member` directly. This is a **temporary manual bridge** — added so Accounting can enroll anyone before employees self-serve via the Employee Dashboard's MESA Request tab (which goes through the `mesa_requests` review queue below). Remove this direct-toggle path once that's the primary way members join.
- **MESA Active Members** — the enrolled members (`employee_hourly_rates.mesa_member = true`), roster-grounded so a brand-new enrollee shows up (at ₱0) even before their first ledger row lands. Financial rollup (Contributed / Matched / Disbursed / Balance) from `mesa_ledger`, scoped to the member's **open account**; an **Account #** column shows the `YY-MM-#####` number (searchable, also echoed in the View drill-down header). Each row has **View** + **Opt Out**; **bulk Opt Out** via row checkboxes. Opting out closes the account (zeroing the visible balance); a later re-opt-in mints a fresh account number. Initial membership is seeded from the Active sheet — see below.

### Seeding active membership (from the Active sheet)

`references/sql/seed/seed_mesa_active_membership.sql` flags the ~273 non-Inactive members on the Active sheet (`references/docs/mesa_active_export.csv`) as `mesa_member = true` on `employee_hourly_rates`, anchoring `mesa_member_since` to each member's earliest recorded deposit. Run once in the Supabase SQL Editor; idempotent. Mirrors the scope of `scripts/preload-mesa-membership.mjs` (which does the same from the `mesa_ledger` table when it's populated) but is self-contained from the CSV, so it works even if the ledger was never backfilled. Members flagged here populate the **MESA Active Members** tab; roster employees who have never joined fall to **Non Members** (opted-out ex-members, who keep a start date, appear on neither).

Reviews go through `PATCH /api/mesa-requests/[id]` (`requireFeatureEditAnyView('mesa')`). Approving an `opt_out` also fires `POST /api/toggle-mesa-member` with `mesaMember: false` to stop the deduction; revoking re-enrolls.

**Opt-out effective date** (2026-07-29): the member picks the day their participation ends; it rides on `mesa_requests.effective_date` and shows in the queue's Details column, the Review modal, and the export. **Accounting can edit it** — the Review modal renders it as a date picker that saves on pick (optimistic, rolls back on failure) via `PATCH /api/mesa-requests/[id]` with `{ effective_date }`. That works at any status: a decided opt-out gets a calendar button in the row's Action cell that reopens the same modal in read-only "Details" mode (notes and reviewer shown, no Approve/Deny — revoke from the row to reopen the decision itself). Legacy opt-outs filed before the column existed show "Not set" and can be filled in the same way. Approval is still **immediate and manual** — nothing schedules a future-dated opt-out — so the Review modal flags a future date and tells the reviewer to hold the decision until then if the deduction should keep running. Apply `references/sql/alter/2026-07-29_add_mesa_effective_date.sql` (`node scripts/apply-mesa-effective-date.mjs`, needs `DATABASE_URL`) **before deploying** — the form POSTs the column, so without it every opt-out submission fails.

### Disbursement receipts (`mesa_request_receipts`) — 2026-07-29

The program has always required receipts ("within 14 days… must be valid and include the merchant's name"), but until now there was nowhere to put one: it arrived over email or not at all, so Accounting reviewed a disbursement with **no evidence attached to the request it was deciding**. Members now attach up to **three** files per disbursement.

**Employee side** — a **Receipt** column in Employee → MESA → Request → **Past requests**, sitting next to Amount (the receipt is the evidence for that number). Only a `disbursement` row is eligible; `opt_in` / `opt_out` / `return` and **denied** disbursements render a dash rather than an action that can't complete (the API refuses those uploads too). The cell is an **Attach** chip at zero receipts and a teal `🧾 N` count once there are some; either opens `MesaReceiptDialog` (`src/components/employee/MesaReceiptDialog.tsx`) — drag-and-drop or browse, live thumbnails, per-file remove, and the 14-day/merchant-name rule restated where it applies. It is **portaled to `<body>`**: the MESA tab's content animates `filter`, which makes that element the containing block for fixed-position descendants, so an in-place overlay would be clipped to the tab panel.

**Accounting side** — the Requests queue has its own **Receipt** column between Details and Amount (2026-07-31; it started as a chip buried under the reason in the Details cell). Per row: a teal `🧾 N files` button — amber when the newest file landed past day 14 — over the newest upload's day, `None` for a disbursement with nothing attached (amber with the age, e.g. `None · 19d`, once a still-live request is past 14 days; a **denied** draw released no money so it's never overdue), and a dash for the other request types and for an unknown count. The button opens the same Review modal the Review action does, at any status. Scanning one column answers "which of these thirty draws is substantiated, and which is late" without opening a single row. The Review modal seats the files in a **gallery pane on the right** (2026-07-31; the modal widens to `lg:max-w-4xl` for a disbursement, and the pane stacks under the details below `lg`): a large hero preview of the active receipt, a thumbnail strip for the other two, the file's size / upload date / **how many days after the request** it landed (past 14 days in amber), and three actions — **Maximize**, **New tab**, **Download**. Clicking the hero maximizes it too. Read-only for Accounting on purpose: this is the evidence the decision rests on. A **Receipts** count column is in the CSV/XLSX/PDF export.

**Maximize** is a portaled lightbox (`z-[9999]` on `document.body` — the review modal is itself `fixed` and the app shell isolates its stacking context, so an in-place overlay would render *under* one of them). A photographed receipt is unreadable at gallery size, and this is where the merchant's name and amount actually get read: the image fills the viewport, a **PDF is embedded in an iframe** rather than bounced to a new tab, `Esc` closes, `←`/`→` walk the files (the gallery follows along), and New tab / Download stay in the top bar. **Download** works by appending `?download=<file name>` to the signed URL (`mesaReceiptDownloadUrl`) — `<a download>` is ignored cross-origin and receipts are served from the storage host, so the attachment has to be asked for server-side.

**Storage + shape.** Objects live in the **private** `mesa-receipts` bucket at `<sanitized-email>/<request-id>/<slot>-<ts>.<ext>`, read exclusively through 1-hour signed URLs — never a public URL. One row per file in `mesa_request_receipts` (not a JSONB array on `mesa_requests`): per-file `uploaded_at` is what proves the 14-day rule was met, and inserts can't clobber a sibling the way a wholesale blob replace can (see `memory/notes-adjustment-bridge-loss.md`). The **3-file cap is the `(request_id, slot)` unique constraint**, not an API count check a double-submit could race past — `createMesaReceipt` picks the lowest free slot and retries once against a re-read when it loses the race.

**Type checking is by content, not Content-Type.** `sniffReceiptMime` (`src/lib/mesa/receipt-sniff.ts`, covered by `receipt-sniff.test.ts`) reads the magic number: JPEG / PNG / WebP / HEIC / HEIF / PDF only. The declared MIME is never trusted — it's spoofable and genuinely wrong for iPhone HEIC — so an executable renamed `receipt.pdf`, an SVG (a script vector when served back), a ZIP-based Office file, and a PDF signature at a non-zero offset are all rejected before anything reaches the bucket. 5 MB per file, one file per request, uploaded sequentially so a single body stays inside the serverless limit.

**Endpoints** — `GET|POST|DELETE /api/mesa-requests/[id]/receipts`, authorized as the parent request's **owner OR an elevated role** (the same gate as `GET /api/mesa-requests?email=`); `uploaded_by` records which. `GET /api/mesa-requests` attaches `receipt_count` + `receipt_last_uploaded_at` to disbursement rows in one extra round trip. Removal is available to the member (a mis-picked file is the common case) and every deletion is audited — `mesa.receipt.uploaded` / `mesa.receipt.deleted`.

Apply `references/sql/migrate/2026-07-29_mesa_request_receipts.sql` (`node scripts/apply-mesa-receipts.mjs`, needs `DATABASE_URL`) **before deploying**. A deploy that lands first degrades rather than breaks: `countMesaReceipts` swallows a missing table and returns `{}`, so every row reports an unknown count (the Receipt column shows a dash, the export prints `-`) until the migration runs.

### HR tab — `HrMesa.tsx`

`src/components/hr/HrMesa.tsx` (HR → MESA) has an **Eligible** sub-tab, a **Requests** sub-tab (opt-in queue, `?request_type=opt_in`), and an **FPU** sub-tab. Approving an opt-in fires `POST /api/toggle-mesa-member` with `mesaMember: true`, enrolling the member so the Wizard begins the weekly deduction.

---

## How contributions surface

All three dashboards read the same ledger via `GET /api/mesa-ledger` and render with `src/lib/mesa/ledger.ts` types.

### Accounting — MESA Active Members

`AccountingMesa.tsx` → MESA Active Members view. Roster-grounded per-member table (Global Master List × `employee_hourly_rates.mesa_member` × `GET /api/mesa-ledger` program-wide summaries): Contributed / Matched / Disbursed / Balance / Member since, with summary cards for the totals. Searchable, paginated (20/page). Each row has a **View** button opening a drill-down modal (`MesaMemberDetail`) with three tabs, fetched in parallel on open:

- **Timeline** — the member's full deposit + disbursement history (`GET /api/mesa-ledger?email=`), with any frozen legacy `notes` / `additional_notes` from that event shown inline.
- **Requests** — the member's full `mesa_requests` history (`GET /api/mesa-requests?email=`), including `opt_in` (HR's, but shown here for the complete picture) and each request's review notes.
- **Notes** — the ongoing `mesa_notes` log (`GET`/`POST /api/mesa-notes`), with a composer to add a new internal note on the spot.

### HR — Eligible list

`HrMesa.tsx` → Eligible sub-tab. Joins the roster to the ledger by email (`GET /api/mesa-ledger`), surfacing each employee's contribution rollup (`MesaMemberSummary`, `null` when there's no ledger history).

### Employee — MESA History

`EmployeeMesa.tsx` → History sub-tab. Calls `GET /api/mesa-ledger?email=` (self-scoped via `authorizeEmailAccess`). When real ledger data exists it wins (`RealMesaHistory`): a hero with the member's actual Contributed / Matched / Balance, then a **week-by-week ledger of deposits & disbursements** in a **fixed-height scroll region (~740px, roughly 20 rows) with a search box and no pagination** — all matching rows render inside the scroller. If the member has no ledger rows yet, the tab falls back to a **projected** weekly ledger computed from the enrollment date (`mesa_member_since`, else hire date) at ₱100 + ₱300/week, excluding the in-progress week — clearly labeled as a projection.

---

## The Payroll Wizard deduction

The Wizard (`src/components/PayrollWizard.tsx`) drives MESA money into pay via the Additions **"MESA"** column, using two inputs:

1. **Weekly deduction (−₱100).** Applied automatically to members whose rates row has `mesa_member = true`, but only for weeks on/after `mesa_member_since` (both dates are `YYYY-MM-DD`, compared lexically against the week end) **and who are not currently opted out** (see below). This flag is set by `POST /api/toggle-mesa-member` (from HR opt-in approval) and preloaded from the ledger by `scripts/preload-mesa-membership.mjs`.
2. **Disbursement (+PHP).** Approved, not-yet-dispatched `disbursement` requests (`GET /api/mesa-requests?request_type=disbursement&status=approved`) are folded in per employee. A disbursement **only adds** to pay — it no longer forces the −₱100 (an opted-out ex-member being paid an approved disbursement must not be charged; the disbursement-implies-deduction override was removed).

Net effect on Final pay: `finalPay = initialPay + bonuses − mesaDeduction + mesaDisbursement + orphanagePay`. The `mesa_deduction` / `mesa_disbursement` breakdown is carried on the paystub payload so the Employee dashboard can itemize the weekly ₱100.

### Never deduct from a non-member (opt-out suppression)

The bare `mesa_member` flag is not sufficient: it can drift `true` for someone who
has since opted out. The Accounting **Non Members** tab already uses a stronger
rule — someone whose MESA **ledger last event is an opt-out** is a non-member
regardless of the flag (`lastEventOptedOut` in `src/lib/mesa/ledger.ts`). The
Wizard now mirrors that tab exactly so a flag-drifted ex-member is never charged.

- The Wizard fetches `GET /api/mesa-ledger` → `members[].lastEventOptedOut` into
  `mesaOptedOutEmails`, and a shared `isMesaOptedOut(rowEmail, rateRow)` predicate
  suppresses the ₱100 at **all 7 deduction sites** (main compute; Additions
  per-row + department summary; HSL per-row + footer; Step-7 final rows).
- **Rule:** deduct only when `mesa_member === true && !isMesaOptedOut`.
- **Fail-safe:** if the ledger is unavailable, `mesaOptedOutEmails` is empty and it
  falls back to flag-only behavior — it never *re-introduces* a deduction.
- **Re-join is safe:** opting back in opens a fresh `mesa_accounts` row; the ledger
  API scopes each member to their **open** account window (`summarizeMemberAccount`),
  so a re-joined member's `lastEventOptedOut` resets to `false` and the deduction
  resumes. Locked by `src/lib/mesa/ledger.test.ts`.
- Everything downstream (paystub-fresh, Payment Dispatch, Mark Paid) inherits the
  Wizard's `mesa_deduction`, so this one change fixes the whole chain.

### Weekly deposits from the Hubstaff upload (and their reversal)

Uploading a pay week's Hubstaff CSV — or the API sync, manual or the
[weekly auto-sync cron](./hubstaff-weekly-auto-sync.md) — writes one **₱100 + ₱300
deposit row into `mesa_ledger` per opted-in member** for that Sun–Sat week
(`recordMesaWeeklyContributions`, `src/lib/mesa/record-weekly-contributions.ts`;
added 2026-07-20). It is idempotent per (member, week): re-uploading the same
week dedupes against existing deposits, and undatable filenames are skipped.

**Deleting a week cascades (2026-07-25).** `DELETE /api/hubstaff-hours?source_file=…`
now also:

- **Reverses the week's deposits** via `deleteMesaWeeklyContributions` — but only
  rows this app wrote (dated exactly on the week end, standard ₱100/₱300, no
  tracker provenance: `status` / `opt_in_number` / `fpu_completion_date` all
  null; disbursement rows excluded outright). If another surviving upload still
  covers the same pay week (a corrected re-upload under a new filename) the
  deposits stay and the call reports `weekStillCovered`.
- **Deletes the week's `payroll.available` notifications**
  (`deletePayrollAvailableNotifications`, keyed by source file).

Before the cascade existed, a deleted week left orphaned deposits inflating
Employee-Dashboard balances — the 2026-07-25 incident was cleaned up with the
one-off `scripts/cleanup-orphaned-mesa-week.mjs` (dry-run default; backup kept).

**Date rendering gotcha:** `mesa_ledger` date columns are Postgres `DATE`
(date-only). Rendering them with `new Date('YYYY-MM-DD')` shifts them a day west
of UTC — use `parseDateOnlyLocal` from `src/lib/date-only.ts` (Accounting +
Employee MESA views were fixed 2026-07-25; other DATE-column surfaces in the app
may still shift).

**Related — the rates sheet no longer touches `mesa_member`.** A rates-sheet
re-upload used to write `mesa_member` (a silent re-enrollment path that could flip
an HRIS opt-out back to `true`). That write was removed
(`src/lib/supabase/rates-upload-db.ts`); opt in/out is **HRIS-only** now
(`toggle-mesa-member` + `preload-mesa-membership.mjs`), and the sheet is read-only
for MESA.

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
| List / attach / remove a disbursement receipt (`/api/mesa-requests/[id]/receipts`) | Parent request's owner **or** elevated (`authorizeEmailAccess` on the row's `work_email`) |
| Dispatch an approved disbursement | Elevated session (see urgent-payments.md) |
| List / add a member's internal note (`/api/mesa-notes`) | `requireElevatedSession` (list) / `requireFeatureEditAnyView('mesa')` (add) |
| Directly toggle a member's enrollment from Accounting → MESA → Non Members (temporary bridge, bypasses the request queue) | `requireFeatureEditAnyView('mesa')` |

---

## Key files

| Path | Role |
|---|---|
| `src/components/employee/EmployeeMesa.tsx` | Employee About / Request / History tabs + the Past-requests **Receipt** column |
| `src/components/employee/MesaReceiptDialog.tsx` | Receipt upload dialog (portaled, drag-and-drop, ≤3 files, thumbnails, per-file remove) |
| `src/components/payroll/AccountingMesa.tsx` | Accounting Requests queue + Non Members (temp Opt In/Out) + MESA Active Members + View drill-down |
| `src/components/hr/HrMesa.tsx` | HR Eligible / opt-in Requests / FPU tabs |
| `src/components/PayrollWizard.tsx` | Weekly deduction + disbursement folded into Final pay |
| `src/lib/mesa/ledger.ts` | Shared ledger types + `summarizeMember` / `summarizeMembers` |
| `app/api/mesa-requests/route.ts` | GET (list/own) + POST (submit) |
| `app/api/mesa-requests/[id]/route.ts` | PATCH (approve/deny/revoke) + DELETE |
| `app/api/mesa-requests/[id]/receipts/route.ts` | GET (list + signed URLs) / POST (attach one file) / DELETE (`?receipt_id=`) |
| `src/lib/mesa/receipt-types.ts` | Shared limits + shape (3 files, 5 MB, accepted MIME, size formatting) — browser-safe |
| `src/lib/mesa/receipts.ts` | Server CRUD: slot assignment w/ race retry, private-bucket upload, signed URLs, audit |
| `src/lib/mesa/receipt-sniff.ts` | Magic-number content check — the gate on what enters the bucket (tested) |
| `references/sql/migrate/2026-07-29_mesa_request_receipts.sql` | `mesa-receipts` private bucket + `mesa_request_receipts` table (3-file cap as a unique constraint) |
| `scripts/apply-mesa-receipts.mjs` | Applies + verifies the receipts migration (`DATABASE_URL`, `--verify` to check only) |
| `app/api/mesa-requests/[id]/dispatch/route.ts` | Pay out an approved disbursement |
| `app/api/mesa-ledger/route.ts` | Per-member or program-wide contribution rollup |
| `app/api/mesa-notes/route.ts` | GET (list) + POST (add) a member's internal notes |
| `app/api/toggle-mesa-member/route.ts` | Direct enrollment flip — used by request approvals and the temporary Non Members Opt In/Out buttons. Opt-in opens a `mesa_accounts` row (minting the next `YY-MM-#####`), opt-out closes it and clears `mesa_account_number` |
| `src/lib/supabase/mesa-accounts.ts` | Account registry helpers: list/get open accounts, `openMesaAccount` (serial minting, collision-retried), `closeMesaAccounts` — all tolerant of the migration not having run |
| `references/sql/migrate/2026-07-16_mesa_accounts.sql` | `mesa_accounts` DDL + `employee_hourly_rates.mesa_account_number` + view recreate (run in the SQL Editor) |
| `scripts/seed-mesa-accounts.mjs` | Backfills one account per historical enrollment stint + stamps open account numbers onto rates rows (dry-run default, `--apply` to write) |
| `references/sql/create/mesa_ledger_ddl.sql` | Ledger table DDL |
| `references/sql/create/backfill_mesa_ledger.sql` | Ledger data backfill (loaded via script, not SQL Editor) |
| `references/sql/create/add_mesa_requests.sql` | `mesa_requests` table |
| `references/sql/create/create_mesa_notes.sql` | `mesa_notes` table |
| `references/sql/seed/seed_mesa_active_membership.sql` | Seeds `mesa_member=true` for the Active-sheet members |
| `references/sql/alter/add_mesa_dispatched_at.sql` | `mesa_requests.dispatched_at` + urgent-queue index |
| `src/lib/mesa/record-weekly-contributions.ts` | Weekly ₱100+₱300 ledger deposits on Hubstaff upload/sync + their reversal on week delete |
| `src/lib/date-only.ts` | `parseDateOnlyLocal` — timezone-safe rendering of DATE columns |
| `scripts/cleanup-orphaned-mesa-week.mjs` | One-off purge of deposits orphaned by a pre-cascade week delete (dry-run default) |
| `scripts/load-mesa-ledger.mjs` | Batched REST upsert of the original ledger backfill |
| `scripts/load-mesa-ledger-from-csv.mjs` | Refresh the ledger from a new Active-sheet CSV export (preserves dropped disbursement history) |
| `references/sql/migrate/2026-07-16_reload_mesa_ledger_from_active_sheet.sql` | The 2026-07-16 ledger reload as SQL (likely too large for the SQL Editor — use the script) |
| `scripts/preload-mesa-membership.mjs` | Seeds `mesa_member` / `mesa_member_since` from the ledger (run 2026-07-16 against the reloaded ledger — fixed the 13 members the stale Active-sheet seed missed, incl. april@simple.biz's re-join) |
