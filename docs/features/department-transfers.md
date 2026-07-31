# Department Transfers (v2)

Manager-driven, **pull-in** department moves. A **receiving manager** picks a person out of another
team, proposes an effective date, and the person's **current (source) manager** consents by
**Release** (or **Decline**). On release the department label moves **immediately** — in both
`global_master_list` and the master Google Sheet — while the effective date is retained only as the
anchor payroll prorates *pay* by. HR and Accounting only **watch** the history (HR sees no pay;
Accounting sees the Payment-Catalog rate delta each move implies). Built Jul 8–10 2026; supersedes
the old "source manager pushes out → HR approves" flow. **Updated Jul 24 2026:** apply now
reconciles by *target* department (fixing the stuck "Apply now" backlog), and all three Transfers
tabs got KPI cards — the Manager tab a full charts redesign, the Accounting tab search + export.

Key files:

- `app/api/department-transfers/route.ts` — GET (role-scoped lists) + POST (initiate a pull-in).
- `app/api/department-transfers/[id]/route.ts` — PATCH (`release`/`decline`/`cancel`/`apply`) + DELETE.
- `app/api/manager/transfer-candidates/route.ts` — the pull-in picker's server-backed roster (no pay).
- `app/api/accounting/transfers/route.ts` — rate-visible history + Sheet-sync retry.
- `app/api/cron/apply-scheduled-transfers/route.ts` — daily safety-net applier for due `approved` rows.
- `app/api/payroll/rate-history-bulk/route.ts` — the rate-history feed the Wizard prorates against.
- `src/lib/transfers/apply-transfer.ts` — `applyApprovedTransfer` (master + Sheet + notify).
- `src/lib/transfers/accounting-transfers.ts` — joins each transfer to its dept-to-dept rate change.
- `src/lib/supabase/department-transfer-requests.ts` — table row type + all read/write helpers.
- `src/lib/google-sheets/update-master-sheet-department.ts` — the master-Sheet Department write-back.
- `src/lib/payroll/rate-history-resolve.ts` — client-safe as-of-date rate resolution.
- `src/components/manager/ManagerTransfers.tsx` — the Manager Transfers tab (3 sub-tabs, KPI + charts layout).
- `src/components/manager/transfer-charts.tsx` — `StatusDonut` / `FlowBars` for the analytics rail.
- `src/components/accounting/AccountingTransfers.tsx` — Accounting read-only, rate-linked view (KPI cards, search, export).
- `src/lib/transfers/transfers-export.ts` — client-side CSV/XLSX/PDF export of the Accounting table.
- `src/components/hr/HrTransfers.tsx` — HR read-only history (no pay).
- `scripts/clear-stuck-transfers.mts` — one-off backlog cleanup for stuck `approved` rows (dry-run default).
- `references/sql/migrate/2026-07-09_transfers_v2.sql` — v2 schema migration (pending SQL #107).

---

## Pipeline

```
Receiving manager · Transfers ── "Request transfer in" ──▶ POST /api/department-transfers
        │  (picks a person from ANOTHER dept; proposes effective date)   │
        │                                                                ├─ gate: manager||admin; NOT
        │                                                                │  from a dept you manage
        │                                                                ├─ 409 if in-flight already
        │                                                                ├─ insert row (status=pending)
        │                                                                └─ notify SOURCE manager(s)
        ▼                                                                     (transfer.release_requested)
Source manager · Transfers → Release requests ── PATCH {action:'release'} ──▶
        │                                                                │
        │                                                                ├─ lock effective_date = proposed
        │                                                                ├─ status → approved
        │                                                                └─ applyApprovedTransfer() NOW
        ▼                                                                     │
   applyApprovedTransfer                                                      │
     1. global_master_list.Department := to_department  (authoritative)       │
     2. updateMasterSheetDepartment()  (best-effort; sheet_synced/error)      │
     3. status → applied, applied_at set                                      │
     4. notify receiving manager + employee (transfer.applied)                │
        ▼
(safety net) daily cron /api/cron/apply-scheduled-transfers ──▶ applies any 'approved'
             row whose effective_date ≤ today that release-time apply left behind.
```

`decline` → `status=rejected` (+ note back to the requester); `cancel` → `status=cancelled`
(receiving manager withdraws their own pending request).

---

## 1 · Initiate — the pull-in model

Anyone with the `manager` **or** `admin` role can start a transfer, but a plain manager may only
pull a person **into** a department they manage and only **from** a department they **don't** manage
("no poaching off your own team — that's the source manager's Release call"). This is enforced in
**three places** so it can't be bypassed:

- **Endpoint gate.** `POST /api/department-transfers` rejects non-`manager`/`admin` (403), and for a
  non-admin manager with explicit assignments requires `to_department` ∈ managed depts **and**
  `from_department` ∉ managed depts (via `listDepartmentsForManager` + `departmentMatchesManagedAssignments`).
- **Picker exclusion.** `GET /api/manager/transfer-candidates` drops anyone currently in one of the
  requester's own departments (`ownDepts` filter) before returning the roster.
- **POST validation.** Re-checks `from`/`to` are non-empty, differ, and the date matches `YYYY-MM-DD`
  (`ISO_DATE`); dies 400 otherwise.

Admins are **unrestricted** (can pull anyone, including out of a department they also manage), as are
managers with **no** explicit department assignments (elevated). In `ManagerTransfers.tsx` the
`canInitiate` prop is always true for managers; the "Request transfer in" button gates on
`canRequest = canInitiate && myDepartments.length > 0`.

### The candidate picker

`GET /api/manager/transfer-candidates?q=&department=` returns **active** Global-Master-List people
via `listActiveMasterListPeople` — **Name + Department + work/personal email only, never pay**.
`?q=` matches name / department / **work email** / personal email; `?department=` filters to one
dept. The server scans the whole roster and returns both the filtered `people` (capped at 200) and
the full `departments` list for the filter dropdown, so search/filter is server-backed rather than a
client slice of a page.

> **1000-row cap gotcha:** the active-roster readers must paginate — a single `.range(0, 9999)` on
> the `active_employees` view is silently capped at PostgREST `db.max-rows` (1000), which once
> dropped every person past row 1000 from the picker. Any new full-view read must page through.

An employee can only have **one** in-flight transfer: `hasPendingTransferForEmployee` (matches
`pending` **or** `approved` across employee/work/personal email) makes the POST return **409** on a
duplicate.

---

## 2 · Apply — immediate move, effective date governs pay only

On **Release**, `PATCH …/[id] {action:'release'}` locks `effective_date` to the proposed date
(falling back to `manilaTodayIso()` for legacy rows), flips the row to `approved`, then calls
`applyApprovedTransfer` **immediately**. The move is **not** deferred to the effective date — that
was the old "released but nothing changed" limbo. The effective date lives on purely as the
**rate-proration anchor** for payroll.

`applyApprovedTransfer` (`src/lib/transfers/apply-transfer.ts`):

1. **Master list (authoritative) — reconciled by TARGET dept (Jul 24 2026).** The old logic
   insisted on a row still sitting in `from_department`, which stranded overdue transfers whose
   source row had drifted (re-synced, re-labeled, or already half-moved) and could crash into the
   `(work_email, Department)` unique constraint. `applyDepartmentTransfer` now asks the pure
   `planDepartmentApply` (tested in `department-transfer-requests.test.ts`) what the person's
   master rows require to reach the **goal state** ("exactly one row in `to_department`"):
   - `moved` — flip the source row(s) to the target; if a target-dept row already exists, the
     redundant source duplicates are **deleted** instead of moved (dodging the unique constraint);
   - `satisfied` — already in the target: nothing to write, and the Sheet write-back is skipped
     (`sheet_synced=true`, the Sheet already reflects the end state);
   - `notFound` — no roster row by any email: an **expected** outcome, not an error — the request is
     **auto-cancelled** with a note ("not on the active roster … off-boarded or email changed")
     instead of stranding in `approved` forever. (A bug where `notFound` returned a non-null error
     and tripped the error guard *before* the auto-cancel branch was fixed in the same pass.)
   A genuine master-list write failure is still **fatal**: nothing is applied and the row stays
   `approved`. `scripts/clear-stuck-transfers.mts` (`npx tsx`, dry-run by default) pushes any
   historical stuck-`approved` backlog through the new logic.
2. **Google Sheet write-back (best-effort).** `updateMasterSheetDepartment` reads the master tab,
   finds the matching row (same email-AND-source-dept match) and flips its Department cell via
   `values:batchUpdate`. This is the whole point of v2 — the Sheet is the roster source of truth and
   the `(Work Email, Department)` sync key would otherwise revert or duplicate the move. Failure is
   **non-blocking**: the row still becomes `applied` with `sheet_synced=false` + `sheet_sync_error`.
3. **Record + notify.** `markTransferApplied` sets `status=applied`, `applied_at`; the receiving
   manager and the employee get a `transfer.applied` notification.

If step 1 fails on release, the endpoint returns `200 { released:true, applied:false, error:… }` and
tells the manager to **Retry with "Apply now."** "Apply now" (`PATCH {action:'apply'}`, admin or
source-dept manager, gated by `requireFeatureEdit('manager','team')`) pushes any leftover `approved`
row through. **Past effective dates are allowed** — a backdated transfer applies now and payroll
prorates it retroactively.

### The cron (safety net)

`GET|POST /api/cron/apply-scheduled-transfers` (Vercel `Bearer CRON_SECRET`, or an elevated in-app
session for a manual trigger) calls `listScheduledDueTransfers(today)` — every `approved` row with
`effective_date ≤ today` — and applies each. Because apply-on-release is the norm, this only mops up
rows whose release-time apply failed; it's idempotent (a row is only picked up while `approved`,
then flips to `applied`).

---

## 3 · The three surfaces

### Manager → Transfers tab (`ManagerTransfers.tsx`)

A dedicated tab (id `transfers`, feature `transfers`), redesigned Jul 24 2026 (via `impeccable`)
into a full-width two-column layout: the **requests list on the left** (compact rows, paginated
15/page) and an **analytics rail on the right** — three stacked KPI cards plus charts
(`StatusDonut` / `FlowBars` from `src/components/manager/transfer-charts.tsx`). The **Done** sub-tab
rows lead with a status icon chip (green check = Applied, sky calendar = Released/scheduled, rose X
= Declined), paginated 10/page. An **animated segmented control** (motion `layoutId` pill +
`AnimatePresence` view transitions) drives three sub-tabs via
`GET /api/department-transfers?scope=…`:

| Sub-tab | Scope | Contents |
|---|---|---|
| **Release requests** | `incoming` | Pending requests where this manager owns the **source** dept — their consent queue. Release / Decline (Decline requires a note). |
| **My requests** | `outgoing` | The manager's own outbox. `pending` → **Withdraw**; `approved` → **Apply now**. |
| **Done** | `done` | Resolved release requests on their team (released/declined/applied/cancelled) — a read-only record after they act. |

Cards show relative timestamps (`timeAgo`) with a full-stamp hover tooltip. Every row across all
three sub-tabs carries a **two-click trash Delete** control (`renderDeleteControl`): first click arms
"Delete?", second confirms. `DELETE …/[id]` **hard-deletes the request record only** — it does **not**
reverse an already-applied department move — and is allowed to the original requester, a source-dept
manager, or an admin. "Request transfer in" opens `ManagerTransferDialog` from the header.

### HR → Transfers tab (`HrTransfers.tsx`)

Read-only history, **no pay**. HR no longer approves anything (v2). Four KPI cards (Total /
In progress / Completed / Declined-cancelled), then **In progress** (pending) and **History**
(everything else), showing who was moved, both manager decisions (`requested_by` /
`approver_email`), the effective date, and a Sheet-synced / not-synced badge.

> **The tab must fetch `?scope=all`** — fixed 2026-07-30 (`19e504b`).
>
> HR's tab was **silently empty** because of a regression in `7c8e314`. It used to fetch
> `/api/department-transfers` with **no** `scope`, and that unscoped HR/admin default
> originally returned *every* transfer. When the admin action-queue tabs were fixed, the
> default was repurposed to return only requests **the caller raised themselves** — and
> since HR coordinators never raise transfers, the "read-only full trail" became a
> permanently empty outbox.
>
> The route now has an explicit **`scope=all`** (HR/admin only) that returns the complete
> trail via the previously-orphaned `listAllTransferRequests()`. Every other scope is
> unchanged: `incoming`/`done` for the action queues, **unscoped stays the personal
> outbox**, manager scopes still narrow to their departments.
>
> The (roles, scope) → list dispatch had lived only in route comments, which is why the bug
> survived. It is now the pure function **`resolveTransferListQuery`**
> ([`src/lib/transfers/list-scope.ts`](../../src/lib/transfers/list-scope.ts)) with 10 tests
> pinning every pairing — so the HR history can't be hollowed out again, and nobody can
> "fix" it by changing the default and breaking the admin outbox instead.

### Accounting → Transfers tab (`AccountingTransfers.tsx`)

Rate-visible only — `GET /api/accounting/transfers` is gated by `requireRateVisibilitySession`
(admin / accounting / ceo). Since Jul 24 2026 the table sits under **four click-to-filter KPI
cards** and a **search bar**, with **CSV / XLSX / PDF export** (landscape PDF) via
`src/lib/transfers/transfers-export.ts` — a spec-driven export lib modeled on
`people-roster-export.ts`, entirely client-side. A table of every transfer joined to the pay-rate
change it implies. The
**Rate change** column (`buildAccountingTransfers` → `RateCell`) reads **Payment Catalog DEPARTMENT
base rates** — the from-dept base vs. the to-dept base, **each side in its own currency** — via
`buildCatalogRateIndex` over `listPayStructures`. It does **not** read `employee_rate_history`
(department rates are compute-time overlays, not persisted per-employee history):

- **green** = increase, **red** = decrease, **neutral** = equal *or* a cross-currency pair
  (a $10-vs-₱500 numeric compare is meaningless, so it's never colored).
- `no catalog rate set` when neither department has a catalog rate.

An `applied` row whose Sheet write-back failed shows **"Sheet not synced · Retry"**, which POSTs
`{action:'retry_sheet'}` to re-run `updateMasterSheetDepartment` and re-stamp `sheet_synced` via
`setTransferSheetSync`.

> **Important:** the Accounting column reflects the **departmental** rate difference, not
> necessarily one person's take-home change. Only people riding the **department base rate**
> (typically brand-new hires) change pay automatically on transfer; anyone on an individual / sheet /
> history rate keeps that rate until Accounting sets a new one in the Payment Catalog.

---

## 4 · Payroll Wizard mid-week proration

A mid-week transfer can change someone's rate partway through a pay week, so the Wizard's Step-2 calc
now prorates per day the way Payment Dispatch does (previously it applied one blended rate/week).
`proratePayForMidPeriodChange` mirrors Dispatch's `computeProratedRowPay` (from `current-pay.ts`),
resolving each day's rate through the **client-safe** `rate-history-resolve.ts`
(`buildRateHistoryByEmail` / `resolveRateAsOfDate`) fed by `GET /api/payroll/rate-history-bulk`
(rate-visible gated, every `employee_rate_history` row newest-first). History is keyed on the
**Hubstaff `em`** for parity with Dispatch; a real mid-week change surfaces an amber Step-2 badge
(`₱old→₱new eff <date>`). It returns null (single-rate path) when the resolved constant rate equals
the cache, so it's byte-identical except on a genuine change; individual-catalog (flat-rate)
employees are skipped, matching Dispatch.

**Since 2026-07-30 the paystub itself explains the split** (engine extracted to
`src/lib/payroll/prorate-mid-period.ts`, which now also reports per-rate segments): the affected
earnings line keeps its exact row and gains an amber **"Prorated" chip**, a **`₱old → ₱new`**
Hours × Rate cell, and a per-rate hour basis (`16.25h @ ₱175.00 · 23.75h @ ₱225.00 — effective
Jul 22`) — on the shared `PayStubStatement`, the wizard's Paystubs preview, and the n8n email
alike. **Individual Payment Catalog rates no longer flatten the week outright**: both engines
prorate through dated history when it is catalog-consistent (terminal history rate == structure),
and keep the flat week on any disagreement. See
`docs/features/paystub-dispatch.md#mid-week-proration--2026-07-30`.

**Transfers INTO HSL also day-scope the Weekend Hours treatment** (2026-07-30): the +₱15/h Sat/Sun
premium + weekend itemization start on the transfer's effective date — inside the transfer week the
treatment covers only weekend days on/after that date, and a label that moved early (effective date
after the week) earns nothing until its week arrives. Both engines read the effective dates from
`department_transfer_requests` (`resolveHslWeekScope` / `fetchHslTransferEffectiveByEmail`).

---

## 5 · Data model & registration

`department_transfer_requests` (v2 columns added by `2026-07-09_transfers_v2.sql`):

| Column | Meaning |
|---|---|
| `requested_by` | receiving manager (initiator) |
| `proposed_effective_date` | date the receiving manager proposed |
| `effective_date` | **locked** to the proposal on release; the rate-proration anchor |
| `approver_email` / `approver_note` | source manager's decision (reused legacy columns) |
| `applied_at` | when the dept was written to master + Sheet |
| `sheet_synced` / `sheet_sync_error` | Google Sheet write-back outcome (drives the Retry badge) |

Status set: `pending` (awaiting release) → `approved` (released, effective date locked, scheduled) →
`applied` (written to master + Sheet); `rejected` (declined) / `cancelled` (withdrawn) are terminal.

The migration also **widens the status CHECK** with `applied`, **restates the full
`employee_notifications.type` CHECK** adding the four `transfer.release_requested` / `.released` /
`.declined` / `.applied` types, adds a `(status, effective_date)` index for the cron, and adds the
table to the `supabase_realtime` publication so the source manager's consent queue floats in live.
It is idempotent. Both new tabs are registered across `FEATURE_CATALOG` / `VIEW_TAB_IDS` /
`DASHBOARD_PAGES` (per the project memory), and default-deny means two seed scripts
(`seed_manager_transfers_permission.sql`, `seed_accounting_transfers_permission.sql`) grant existing
manager/accounting users. Migration + seeds are tracked as **pending SQL #107**.

---

## Gotchas

- **The move is not deferred.** On release the department changes right away; only *pay* is prorated
  by the effective date. Don't expect a future effective date to hold the label back.
- **409 self-heals in the UI.** Every Manager action (`release`/`decline`/`cancel`/`apply`) treats a
  409 "already decided" (co-manager acted, another tab, or the cron) as a stale card: it shows an
  info toast and reloads instead of erroring again.
- **Delete ≠ undo.** Deleting a request removes the record only; an already-applied department move
  stays applied.
- **Sheet failure is silent-but-tracked.** The transfer still applies; watch the Accounting tab's
  "Retry" badge to reconcile the Google Sheet.
- **A stale Sheet paste silently reverts applied transfers.** See below — this bit 13 people
  on 2026-07-30.

---

## 6 · Playbook: a stale Sheet paste reverted applied transfers *(2026-07-30 incident)*

**Symptom.** A transferred person **vanishes from the HR Global Master List** (or shows their
old department) even though the transfer record says `applied` and its original Sheet
write-back succeeded.

**Cause.** The master Google Sheet is the sync's source of truth for `(Work Email,
Department)`. If someone restores or pastes a chunk of the Sheet from an **older snapshot**,
every department change written since that snapshot is wiped — and the next sync either mints
a **duplicate row in the old department** or strands the new-department row as not-last-seen
(invisible). The transfer record still reads `applied`, so nothing in the app looks wrong.

**What happened.** Curing a set of dropped-off rows on Jul 30 pasted pre-Jul-24 data. An audit
of all **117 applied transfers** found **11 people** silently reverted this way — plus Krizia
(the reported case) and Glaiza, **13 restored in total**:

| Requested by | People | Move |
|---|---|---|
| carla@ (Jul 30 batch) | Cantoria Gerald, Redoble Fernan, Guevarra Charissa, Bahan Judith, Cinco Yousef | Lead Gen → HSL |
| jackie@ (Jul 24–30) | Bucayani Eriksson, Capati Lourdino, Chua Lauren, Cacho Glenda, Cestina Jose | HSL → Lead Gen |
| carla@ (Jul 24) | Rosero Jerome | QC → Callback Team |

**Fix, per person** (back up the rows to the run log first):

1. Flip the **Sheet cell** back to the transfer's target department.
2. **Restamp the DB row visible** (`last_seen_upload_id` → the current master-list upload).
3. **Delete any sync-minted duplicate**, leaving exactly **one active row**.

**Two detection lessons:**

- **A transfer-record audit is not sufficient.** Glaiza Garcia had **no transfer record at
  all** — her Lead Gen → HSL move was made by editing the Sheet directly in early June and
  captured by a sync. Sheet-only moves are invisible to a transfers audit.
- **Therefore the real check is a full Sheet-vs-DB consistency sweep**: match every Sheet row
  against every DB row by **both** emails and compare departments. The Jul 30 sweep (1,326
  Sheet rows × 2,311 DB rows) came back with **zero** department mismatches, zero unknown Sheet
  identities and zero active people missing from the Sheet — which is what proved there were no
  further hidden cases.

**Cases to escalate rather than silently re-apply:**

- A revert that is **weeks old and has survived payroll cycles** (Gopez Stephen / Quijano RJ —
  transferred Jul 13, back in Client VA for 2+ cycles). Confirm with the requesting manager
  whether the move-back was intentional.
- **Two rows where the sync-current one is offboarded but the Sheet says Active** (Medilo Hanna
  Grace) — the person is invisible; confirm their real status before picking a direction.

**Prevention:** whoever re-adds Sheet rows must paste **current** department values. See the
related "Sheet re-add with an old dept clobbers an applied transfer" rule.

## Related

- **Master sync work+dept guard** — why the Sheet write-back matters: the `(Work Email, Department)`
  sync key would revert a Supabase-only move.
- **Payment Catalog authoritative rates** — where the from/to department base rates come from and how
  individual rates win over the department base at pay time.
- **Rate history + mid-cycle prorating** — the per-day proration the Wizard now mirrors.
- **Dept-manager roster + cascade** — `department_managers` assignments drive every scope check here.
