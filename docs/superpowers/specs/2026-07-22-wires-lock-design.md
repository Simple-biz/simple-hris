# WIRES Lock — a WIRES employee can never be switched to Hurupay/HiGlobe

**Date:** 2026-07-22
**Status:** Approved (design)

## Problem

Accounting pays each employee out on a **send-from rail** — the processor stored in
`employee_ids.bank_preferred` (the "Bank Preferred" pick, already seeded). The three
effective rails are **Hurupay**, **HiGlobe**, and **WIRES** (bank wires). Wise/Jeeves
are retired and non-selectable.

A WIRES employee physically **cannot** be paid through Hurupay or HiGlobe — those are
processor wallets, not bank wires. Today nothing stops someone from changing a WIRES
employee's Bank Preferred to Hurupay or HiGlobe. We need a cross-cutting rule that makes
that transition impossible everywhere a bank change can happen.

> Kane: "I don't want wires to be paid in HURUPAY or HIGLOBE." … "When an employee is
> WIRES then they couldn't be paid from HIGLOBE or HURUPAY because that's impossible."

## The rule

**Source of truth = `employee_ids.bank_preferred` only.** The employee's *receiving* bank
(GoTyme, Maribank, BDO, BPI, …) is informational and does **not** drive the lock — the
send-from rail is what's already been seeded and is what accounting actually pays from.

WIRES is the **residual** category: anything that is not explicitly `hurupay` or `higlobe`
is WIRES. That includes `wires`, `x1153`, legacy free-text values, and **null/unset**
(confirmed: "Treat null as WIRES (locked)").

```
isWiresPreferred(value) := value !== 'hurupay' && value !== 'higlobe'
```

The transition guard:

```
assertBankPreferredTransitionAllowed(current, next):
    if isWiresPreferred(current) && !isWiresPreferred(next):
        REJECT  // a WIRES employee cannot move to hurupay/higlobe
```

### Transition matrix

| current → next | allowed? |
|---|---|
| wires → wires | ✅ |
| wires → hurupay | ❌ |
| wires → higlobe | ❌ |
| null/legacy → hurupay | ❌ (null is WIRES) |
| null/legacy → higlobe | ❌ (null is WIRES) |
| null/legacy → wires | ✅ |
| hurupay → higlobe | ✅ |
| higlobe → hurupay | ✅ |
| hurupay → wires | ✅ |
| higlobe → wires | ✅ |

**Scope:** the lock lives on the **Bank Preferred** field (`bank_preferred`) only. The
Disbursement picker (`preferred_processor`) and the routing resolvers are **not** touched —
this is a write-time lock on future transitions, not retroactive routing coercion. Existing
seeded data is left exactly as-is.

## Components

### 1. Shared helper (new)

Add to `src/lib/employee-payment-processors.ts` (the authoritative employee-side registry):

- `isWiresPreferred(value: string | null | undefined): boolean` — `true` unless the value
  is exactly `'hurupay'` or `'higlobe'`.
- `assertBankPreferredTransitionAllowed(current, next)` (or a boolean
  `isBankPreferredTransitionAllowed(current, next)` the callers turn into a 400) — the
  guard above.

One helper, imported by every enforcement site, so the rule cannot drift.

### 2. UI enforcement — hide the impossible options

Enforcement style: **hide** disallowed options for WIRES employees (chosen over
show-then-reject because the transition is "impossible").

- **Employee Profile → Bank Preferred dropdown**
  (`src/components/employee/EmployeeProfile.tsx` L1893-1910): when the stored
  `bank_preferred` is WIRES (`isWiresPreferred(current)`), filter `BANK_PREFERRED_OPTIONS`
  to only the `x1153 → wires` option, and show a short hint ("Set to WIRES — cannot be
  paid via Hurupay/HiGlobe"). Non-WIRES employees keep the full list.
- **Accounting Issues → Bank Preferred approvals**
  (`src/components/payroll/BankPreferredApprovals.tsx`): a pending request whose target
  would move a WIRES employee to hurupay/higlobe is rendered **not approvable** — Approve
  disabled with a reason. (Approving is the step that writes `employee_ids.bank_preferred`,
  so it must be guarded too.)
- **Disbursement picker** (`preferred_processor`) on Employee Profile, the external
  `update-bank-info` page, and the People tab: **left unchanged**. Bank Preferred is the
  source of truth per Kane; the receiving-channel picker is out of scope.

### 3. API / server backstops (the real enforcement)

UI hiding is convenience; the server guard protects the data even if the UI is bypassed.
`bank_preferred` is set/changed in exactly two server locations — both get the shared guard:

- **`app/api/update-employee-ids/route.ts` → `interceptBankPreferred` (L139-181):** before
  filing a `bank_preferred_change_requests` row, read the current stored value and run the
  guard against the requested value. On violation: return **400** with a clear message and
  file **no** request row.
- **`app/api/bank-preferred-requests/[id]/route.ts` → PATCH approve (L65-88):** re-run the
  guard at approval time against the *current* stored value (it may have changed since the
  request was filed). On violation: block the approve with a clear error and do **not**
  write `employee_ids.bank_preferred`.

No DB migration required — the existing CHECK constraints already restrict the value space;
this rule is a cross-*value* transition guard, not a new column or constraint.

## Data flow

```
employee/HR picks a Bank Preferred value
  → UI already hides hurupay/higlobe for WIRES employees (convenience)
  → POST /api/update-employee-ids
      → interceptBankPreferred: assertBankPreferredTransitionAllowed(current, requested)
          violation → 400, no request filed
          ok        → pending bank_preferred_change_requests row (existing gate)
  → Accounting approves in Issues tab
      → PATCH /api/bank-preferred-requests/[id]: re-check guard vs current stored value
          violation → error, no write
          ok        → employee_ids.bank_preferred = to_value (existing behavior)
```

## Error handling

- Server violations return HTTP **400** with a human-readable message, e.g.
  `"This employee is set to WIRES and can only be paid via wires — Hurupay/HiGlobe is not possible."`
- Approval-side violations surface the same message in the approvals UI and leave the
  request `pending` (accounting can then deny it).

## Testing

- **Unit** (`isWiresPreferred` / guard): the full transition matrix above, including
  `null`, `undefined`, `''`, `'x1153'`, and a legacy free-text value all treated as WIRES.
- **API — update-employee-ids:** a WIRES employee (and a null-preferred employee) posting
  `bank_preferred: 'hurupay'` returns 400 and files no `bank_preferred_change_requests` row;
  posting `'wires'` succeeds; a hurupay employee → higlobe succeeds.
- **API — approve:** approving a request that would move a WIRES employee off wires returns
  an error and does not write `employee_ids.bank_preferred`; a valid request still approves.
- **UI:** WIRES employee sees only the wires option in the Bank Preferred dropdown; a
  hurupay employee sees the full selectable list.

## Out of scope / explicitly NOT changed

- The Disbursement picker (`preferred_processor`) and its surfaces.
- The routing resolvers (`mock-queue.ts`, `pay-schedule.ts`, `dispatch-export-csv.ts`) —
  no retroactive coercion of already-seeded data.
- Detecting a local receiving bank (GoTyme/BDO/…) to infer WIRES — Bank Preferred is the
  single source of truth.
- The contractor model (`invoice-payment.ts`) — separate value space, not employee routing.
