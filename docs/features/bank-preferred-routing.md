# Bank Preferred — send-from routing, approval gate & WIRES lock

*Shipped 2026-07-22; Wise updates + the No-Bank clobber discovery added
2026-07-25 (§7); People-tab parity + Accounting direct-edit added 2026-08-10
(§8). Migration status re-verified against production 2026-08-11 — see
[Migrations](#migrations).*

"Bank Preferred" is the processor **Accounting sends a salary OUT on** — the
*send-from rail*. It is a first-class, employee-owned field that wins Payment
Dispatch's processor-routing precedence, is **held for Accounting approval**
before it takes effect, and carries a hard **WIRES lock** that a wires employee
can never be moved off of onto Hurupay/HiGlobe.

> **Do not conflate three separate things.** They live in different columns and
> mean different things:
>
> | Concept | Column | Meaning |
> |---|---|---|
> | **Bank Preferred** | `employee_ids.bank_preferred` | Which processor/rail Accounting pays **out** on (this doc). |
> | **Disbursement** | `employee_ids.preferred_processor` | How the employee elects to **receive** (radio tiles, own detail fields). |
> | **Receiving account** | `employee_ids.account_number` / `swift_code` / wallet-email cols | The employee's own bank/wallet where the money lands. |
>
> A Bank Preferred change never touches the receiving account; the Disbursement
> picker and Bank Preferred dropdown keep **independent** React state. The first
> build wired both to `preferred_processor`, so changing one flipped the other —
> that was a bug, now fixed.

---

## 1. The dropdown (Employee → Profile → Payment)

A `SmoothSelect` below the Disbursement form. Options and their stored processor
ids come from `BANK_PREFERRED_OPTIONS` in
[`src/lib/employee-payment-processors.ts`](../../src/lib/employee-payment-processors.ts):
HiGlobe / Hurupay / Jeeves / Wise / **x1153**.

- **`x1153` → `wires`.** `x1153` is a specific wire account, not a distinct
  processor, so it maps to the `wires` processor id. Because there is no separate
  non-x1153 `wires` option, a saved `wires` value **displays as "x1153"** in the
  dropdown.
- The field shows a **"Pending approval"** badge whenever the employee has an
  outstanding change (see §3).
- `EmployeeIdRow` and both `.select(cols)` strings in
  [`src/lib/supabase/employee-ids.ts`](../../src/lib/supabase/employee-ids.ts)
  must list `bank_preferred`, or reads return `undefined`.

## 2. Routing precedence (how Payment Dispatch picks the rail)

When Payment Dispatch decides which processor tab a person lands in, it resolves
in this order — **Bank Preferred wins**:

```
employee_ids.bank_preferred            (this field — highest)
  ↓ else
employee_ids.preferred_processor       (the Disbursement pick)
  ↓ else
employee_hourly_rates."Bank Preferred" (legacy CSV free-text routing hint)
```

Applied in the routing resolvers: `mock-queue.ts` (the live queue),
[`pay-schedule.ts`](../../src/lib/payroll/pay-schedule.ts)
(`resolveEmployeeProcessor`), and
[`dispatch-export-csv.ts`](../../src/lib/payroll/dispatch-export-csv.ts)
(`buildDispatchExportRows` — where a *recorded* `dispatch.processor` still wins
first). The `preferred_processor` value must be **NULL** for the CSV-seeded
routing to be authoritative, since it outranks the legacy CSV column.

> **Sub-₱7k wires → Wise (2026-07-29).** After the precedence resolves to
> `wires`, Payment Dispatch reroutes the payment **via Wise for that week** when
> the week's PHP amount is strictly under ₱7,000 — recomputed every cycle, never
> written to `employee_ids`, so a ≥₱7k week lands the person back on Wires by
> itself. No interaction with the WIRES lock (§4), which guards *stored*
> transitions. Detail:
> [payment-dispatch.md §12.3.1](./payment-dispatch.md#1231-sub-₱7k-wires--wise-temporary-weekly-reroute-2026-07-29).

> **Known gap (accepted, awaiting a product call):** the All-Dept rates sheet
> writes free-text "Bank Preferred" into the lowest-precedence
> `employee_hourly_rates."Bank Preferred"` column
> ([`rates-upload-db.ts`](../../src/lib/supabase/rates-upload-db.ts)). For a
> person whose `bank_preferred` **and** `preferred_processor` are both null, a
> sheet cell saying "Hurupay" still routes them to Hurupay — a bulk path around
> the WIRES lock's intent. Needs a ticket or an explicit "accepted".

## 3. Accounting approval gate

Employee Bank Preferred changes do **not** write `employee_ids` directly. They
are held as a `pending` row and approved by Accounting first — mirroring the MESA
Requests workflow.

**Flow:**
1. Employee changes Bank Preferred → a `pending` row is inserted into
   `bank_preferred_change_requests` (data layer:
   [`src/lib/supabase/bank-preferred-requests.ts`](../../src/lib/supabase/bank-preferred-requests.ts)).
   The **old value stays live** for Payment Dispatch until approved. Other bank
   fields on the form still save immediately. **First-time set is also gated.**
2. The write path is intercepted in
   [`app/api/update-employee-ids/route.ts`](../../app/api/update-employee-ids/route.ts)
   (`interceptBankPreferred`), which is **fail-closed** — it never writes
   `bank_preferred` without filing a request.
3. **One pending per employee** (partial unique index). A re-submit supersedes
   the previous pending row; two near-simultaneous submits that trip the index
   (Postgres `23505`) are retried once instead of surfacing a raw 500.
4. Accounting approves/denies in the **Issues tab** (internal id `disputes`,
   gated by `requireFeatureEditAnyView('disputes')`) via
   [`BankPreferredApprovals.tsx`](../../src/components/payroll/BankPreferredApprovals.tsx),
   rendered above the PAB dispute queue. **Approve** writes
   `employee_ids.bank_preferred` (bootstrapping a row if none) and notifies the
   employee (`bank_preferred.decided`); **Deny** leaves the value untouched.

API routes: [`app/api/bank-preferred-requests/route.ts`](../../app/api/bank-preferred-requests/route.ts)
and [`[id]/route.ts`](../../app/api/bank-preferred-requests/[id]/route.ts).

## 4. The WIRES lock

A **WIRES employee** — one whose `employee_ids.bank_preferred` is anything but
exactly `hurupay`/`higlobe`, **including `null` and legacy free-text** — can
**never** be switched to Hurupay or HiGlobe. WIRES is the residual bucket.

Single source of truth, both unit-tested (incl. mixed-case legacy free-text) in
[`src/lib/employee-payment-processors.ts`](../../src/lib/employee-payment-processors.ts):

```ts
isWiresPreferred(value)                    // true unless value is exactly hurupay/higlobe
isBankPreferredTransitionAllowed(current, next)
  // false iff current is wires-preferred and next is NOT wires-preferred
```

**Allowed:** `hurupay ↔ higlobe`, and `anything → wires`.
**Blocked:** `wires/null/legacy → hurupay | higlobe`.

Four enforcement sites (defense in depth):

| Site | Behavior |
|---|---|
| `update-employee-ids` intercept | **400** before a request is even filed |
| Approval **PATCH** re-check | re-checks against the **live** stored value at approve time → 400, request stays pending |
| Employee Profile dropdown | **hides** hurupay/higlobe options for a wires employee |
| Accounting approvals row | **Approve disabled** + an "owner-only / locked" row note |

## 5. Mark Paid bank-details override

Separate but adjacent: when Accounting discovers wrong/stale **receiving** details
at pay time, a **pencil** on the Recipient divider of the Mark Paid modal
([`MarkPaidDialog.tsx`](../../src/components/payroll-clerk/MarkPaidDialog.tsx))
enters "override mode" → **Save to profile** writes the corrected receiving
details back to `employee_ids` via
[`POST /api/payment-dispatch/bank-override`](../../app/api/payment-dispatch/bank-override/route.ts).

- Accounting-gated; **deliberately NO dispatch-lock check** — this is the
  sanctioned mid-processing correction path.
- **Never touches routing** (`bank_preferred` / `preferred_processor` stay put) —
  only the receiving account.
- Column mapping is slot-aware (primary vs alternate via `preferred_bank_slot`;
  wallet processors map to their wallet-email columns) in
  [`bank-override-mapping.ts`](../../src/lib/payroll/bank-override-mapping.ts)
  (10 `node:test` cases).
- Shows in **People → Bank Changes** as `via: mark_paid_override` (masked
  values); the employee gets a `people.banking.overridden` notification.
- Also related: a Wise-routed employee now pre-fills **their own** bank on the
  modal ([`mark-paid-defaults.ts`](../../src/lib/payroll/mark-paid-defaults.ts)).

## 6. Data seeding & one-off fixes (2026-07-22)

- **CSV seed of send-from routing.** `references/docs/PD Data.csv` (a PD dispatch
  log) is the intended source of truth for `employee_hourly_rates."Bank Preferred"`;
  ~1,351 people were seeded and `employee_ids.preferred_processor` cleared for 466
  who had a pick, so the CSV routing became authoritative. Receiving accounts were
  left untouched. Done via Node scripts (Kane cannot paste SQL into Supabase);
  **always SELECT-to-backup a column before a destructive bulk UPDATE**.
- **Hurupay-no-email → wires flip.** 17 active people routed to Hurupay who had
  no Hurupay wallet email but full wire info were set to `bank_preferred='wires'`
  (backup in `references/backups/`, gitignored). **48 actives** remain
  Hurupay-routed with neither a Hurupay email nor wire info — a data-collection
  gap (`references/backups/2026-07-22_hurupay_no_payout_data.csv`), candidates for
  the People "Notify" missing-bank-info flow.

## 7. Wise updates & the No-Bank clobber discovery (2026-07-25)

- **Wise un-retired on employee-facing pickers.** `EMPLOYEE_SELECTABLE_PROCESSOR_OPTIONS`
  (`src/lib/employee-payment-processors.ts`) adds Wise to the Readiness "Set bank"
  processor picker and the Employee Dashboard disbursement radios; contractor
  gateways still exclude it. (The People tab always offered it.)
- **Wise = wire fields.** Since Wise payouts land in the payee's **bank account**,
  picking Wise now collects/shows the same field set as Wires (bank, account
  holder/number, SWIFT, address) in People → Banking (editor + reveal), the
  employee payout form (`employee-payout-fields.tsx`), and the Readiness Set-bank
  dialog.
- **PH Global Freelancers Wise seed.** 27 Global-Master-List people from
  `references/docs/PH Global Freelancers .xlsx` were seeded with `wise_email`, a
  last-4 tag, and `bank_preferred='wise'` (`scripts/seed-ph-freelancers-wise.mjs`;
  person-first matching to dodge stale `employee_ids` rows). 15 sheet emails had
  no master row and were skipped; spot-check joshs' `x1153`-style→Wise flip on the
  next cycle.
- **⚠ The §6 seed clobbered self-submissions — restoration OPEN.** An audit of the
  No-Bank list (`scripts/audit-nobank-external-link.mjs`, read-only) found **34 of
  145 listed people had already set their bank** — 28 of them complete Jul-21/22
  **external-link submissions** whose `preferred_processor` the Jul-22 PD-Data
  seed cleared, orphaning their details from the display/routing path. Old values
  are recoverable from `bank_update_history.changes`; the restore has **not been
  run** (Kane's call). One flagged row (Chris Lawang) was a misread — a SELF-row
  shadow, not a clobber.

## 8. People-tab parity & Accounting direct-edit (2026-08-10)

A live audit (`scripts/audit-people-vs-dispatch-banks.mjs`, read-only) found the
People tab disagreed with Payment Dispatch for ~12% of the routed roster: the
roster chip read `preferred_processor` alone (133 people chip-less though PD
routed them, 35 showing the wrong rail), "Missing bank info" ignored the legacy
rates-row fallbacks (27 false alarms), the profile Banking view hid accounts in
the non-preferred slot (9), and `bank_preferred` wasn't surfaced at all. Fixed
by resolving everything People shows through the SAME dispatch-parity helpers:

- **Roster chip + `hasBanking`** ([`people-roster.ts`](../../src/lib/people/people-roster.ts))
  use `resolveEffectivePayoutProcessor` / `isPayoutComplete` **with**
  `PayoutLegacyExtras` from the rates row — and the rate context now loads via
  `getEmployeeHourlyRatesRows()` (the deduped `_current` view PD reads, paged),
  fixing a silent 1000-row truncation of the old raw select.
- **Profile Banking view** ([`PeopleTab.tsx`](../../src/components/people/PeopleTab.tsx))
  shows three routing fields — *Pays via (Payment Dispatch)* (the effective
  rail + source), *Bank Preferred (send-from)*, *Disbursement pick* — keys field
  visibility on the **effective** rail, and falls back across bank slots with
  PD's pickFirst rule. The payload ([`people-banking.ts`](../../src/lib/people/people-banking.ts))
  carries `bank_preferred`, `effective_processor`, `effective_processor_source`;
  a sheet-routed person with no `employee_ids` row still gets a synthesized
  record so their routing shows.
- **Accounting direct-edit.** The People banking editor now offers a *Bank
  Preferred (send-from)* dropdown. `PATCH /api/people/[email]/banking` accepts
  `bank_preferred` **without filing a change request** — the route is gated to
  the same roles that approve those requests, so the edit *is* the approval.
  The **WIRES lock still applies**, enforced server-side against the live
  stored value and mirrored in the dropdown's option filter. The employee
  self-service path keeps the §3 approval gate unchanged. (A direct edit does
  not cancel an employee's pending request; the approval PATCH re-checks the
  lock at approve time as before.)

Parity is pinned by `src/lib/employee/payout-completeness.test.ts` and the
audit script's post-fix run: **0 disagreements across 1,498 active people**.

## 9. Routing + lock hardening (2026-08-10)

A follow-up audit found the same drift class on money-*moving* paths, plus the
locks not covering everything they imply. All fixed in one pass:

- **Urgent Payments preselected the wrong rail.** `preferredProcessor()` in
  [`urgent-payout-details.ts`](../../src/lib/payroll/urgent-payout-details.ts)
  read `preferred_processor` alone and **defaulted to `wise`** (retired), so a
  Hurupay-routed payee's card preselected Wise with no wallet email — and Send
  records a real dispatch. Now resolves with PD's full precedence (incl. a new
  `fetchLegacyBankPreferredByEmail` for the sheet tier) and returns **null**
  when nothing resolves; the card disables Send until the clerk picks a rail.
  Pinned by `urgent-payout-details.test.ts`.
- **`pay-schedule.ts`** returned `employee_ids.bank_preferred` **unmapped**, so
  a stored `x1153` failed `isWireProcessor` and produced a Tuesday pay date for
  a Thursday-paid wires payee. Now goes through the same text normalizer.
- **The Wizard's "People Tab · Live · Banking Info" card** claimed to mirror
  People but used the raw Disbursement pick and no cross-slot fallback. It now
  shows *Pays via* (effective rail) + *Bank Preferred*, with PD's slot fallback.
- **`/update-bank-info` prefill** omitted `bank_preferred`, so a
  `bank_preferred`-routed employee saw an empty picker and had to invent a
  `preferred_processor` that then disagreed with their real rail.
- **Lock coverage.** Approving a Bank Preferred request now checks the dispatch
  lock (it writes the send-from rail; every direct-edit path already did).
  Rate writes, payment-catalog pay structures, and Hubstaff hours POST/PATCH/
  DELETE are now lock-guarded too — previously the derived per-employee bonus
  amounts were guarded but the rates and hours they derive from were not.
- **`app-settings` POST was a lock + audit bypass.** It gated on
  `requireElevatedSession()` only, so `hr_coordinator` could POST
  `payroll.dispatch_locked=false`, drop every bank-edit freeze, and leave no
  audit row — routing around
  [`/api/payroll-dispatch-lock`](../../app/api/payroll-dispatch-lock/route.ts),
  which requires payment_dispatch edit *and* audits. Writes to
  `payroll.dispatch_lock*` now need payment_dispatch **or** payroll_wizard
  edit, sensitive keys (`auth.*`, webhook, token) are **admin-only to write**,
  and all such writes are audit-logged.
- **Contractor rail brought up to the employee rail's standard.** Profile and
  invoice routes had **no authorization at all** — a body-supplied
  `contractor_email` was the write key, and DELETE compared a query param
  rather than the session. Now self-or-elevated on every verb, payout edits are
  dispatch-locked, and they write `audit_log` + `bank_update_history`.
- **`update-employee-ids`** cross-employee writes now require the `people`
  feature (matching `people/[email]/banking`); a self edit can no longer claim
  `source: "people_tab"` in the change feed.

> **Still open — needs a product call.** The per-cycle lock
> (`payroll.dispatch_lock.<sourceFile>`) is read only client-side and gates
> nothing server-side, so "Accounting locked this cycle" is a UI convention.
> Making it also freeze bank edits would match the stated intent but could hold
> employees out for days at a time; deliberately not changed here.

## Migrations

DDL has **no path from the dev environment** — run these in the **Supabase SQL
editor**:

| File | State | Effect |
|---|---|---|
| `references/sql/alter/2026-07-22_add_bank_preferred_to_employee_ids.sql` | applied (column pre-existed; adds CHECK) | the `bank_preferred` column + constraint |
| `references/sql/create/bank_preferred_change_requests.sql` | applied (verified present) | the approval-gate requests table |
| `references/sql/alter/2026-07-22_employee_notifications_add_bank_preferred_type.sql` | **APPLIED** (verified 2026-08-11 — a `bank_preferred.decided` row exists) | allows `bank_preferred.decided` |
| `references/sql/alter/2026-07-22_employee_notifications_add_bank_override_type.sql` | **UNVERIFIED** — a CHECK constraint's allowed values are not readable through PostgREST, and no `people.banking.overridden` row exists yet, which proves nothing either way | allows `people.banking.overridden`; if it has NOT run, the Mark Paid override notification no-ops (the override itself works) |

Both notification migrations restate the **full** `employee_notifications.type`
CHECK list and append the new type — never hand-pick a subset (a subset silently
breaks other notification inserts).

## Key files

| Path | Purpose |
|---|---|
| `src/lib/employee-payment-processors.ts` | `BANK_PREFERRED_OPTIONS`, `isWiresPreferred`, `isBankPreferredTransitionAllowed` (+ tests) |
| `src/lib/supabase/bank-preferred-requests.ts` | approval-gate data layer |
| `app/api/update-employee-ids/route.ts` | `interceptBankPreferred` (fail-closed) |
| `app/api/bank-preferred-requests/route.ts` + `[id]/route.ts` | list / approve / deny |
| `src/components/payroll/BankPreferredApprovals.tsx` | Issues-tab approval UI |
| `src/lib/supabase/employee-ids.ts` | `EmployeeIdRow` + select strings (must list `bank_preferred`) |
| `app/api/payment-dispatch/bank-override/route.ts` | Mark Paid receiving-detail override |
| `src/lib/payroll/bank-override-mapping.ts` | slot-aware override column mapping (+ tests) |
| `src/lib/payroll/{mock-queue,pay-schedule,dispatch-export-csv}.ts` | routing-precedence resolvers |
| `src/lib/employee/payout-completeness.ts` | shared effective-processor + payable resolution (+ tests) |
| `src/lib/people/{people-roster,people-banking}.ts` + `src/components/people/PeopleTab.tsx` | People-tab parity surfaces (§8) |
| `scripts/audit-people-vs-dispatch-banks.mjs` | read-only People↔PD parity guard |

See also: [payment-dispatch.md](./payment-dispatch.md) (the queue this routing
feeds), and the session log
[audit-2026-07-23-session-log.md](../audits/audit-2026-07-23-session-log.md).
