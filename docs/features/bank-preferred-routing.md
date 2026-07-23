# Bank Preferred — send-from routing, approval gate & WIRES lock

*Shipped 2026-07-22. Two employee-notification migrations still PENDING (see
[Migrations](#migrations)).*

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

## Migrations

DDL has **no path from the dev environment** — run these in the **Supabase SQL
editor**:

| File | State | Effect |
|---|---|---|
| `references/sql/alter/2026-07-22_add_bank_preferred_to_employee_ids.sql` | applied (column pre-existed; adds CHECK) | the `bank_preferred` column + constraint |
| `references/sql/create/bank_preferred_change_requests.sql` | applied (verified present) | the approval-gate requests table |
| `references/sql/alter/2026-07-22_employee_notifications_add_bank_preferred_type.sql` | **PENDING** | allows `bank_preferred.decided`; until run, approve/deny won't notify |
| `references/sql/alter/2026-07-22_employee_notifications_add_bank_override_type.sql` | **PENDING** | allows `people.banking.overridden`; until run, the Mark Paid override notification no-ops (the override itself works) |

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

See also: [payment-dispatch.md](./payment-dispatch.md) (the queue this routing
feeds), and the session log
[audit-2026-07-23-session-log.md](../audits/audit-2026-07-23-session-log.md).
