# Bank Preferred dropdown — Employee Dashboard → Profile → Payment

**Date:** 2026-07-22
**Status:** Approved (revised — Bank Preferred is a SEPARATE field from Disbursement)

## Goal

Add a small **"Bank Preferred"** section below the Disbursement form on the
Employee Dashboard Profile → Payment tab, with a single dropdown:
**HiGlobe, Hurupay, Jeeves, Wise, x1153**. The employee's choice is the
processor **Payment Dispatch** routes their salary through — and it is a
**separate, independent field** from the Disbursement channel picker.

## Why this was revised

The first build wired the dropdown to the SAME state as the Disbursement radio
picker (`preferred_processor`). That made changing Bank Preferred also change the
Disbursement selection — the bug the user reported (setting Bank Preferred to
Wise flipped Disbursement from Wires to Wise). Bank Preferred and Disbursement
are **different concepts** and must be stored/edited independently.

## Key decisions

1. **Separate field.** New column `employee_ids.bank_preferred` (text), distinct
   from `preferred_processor`. The dropdown reads/writes its own React state
   (`bankPreferred`); changing it never touches the Disbursement selection.

2. **Bank Preferred drives dispatch, and wins.** Payment Dispatch resolves the
   processor by precedence:
   1. `employee_ids.bank_preferred`   (this dropdown — **wins**)
   2. `employee_ids.preferred_processor` (Disbursement channel)
   3. `employee_hourly_rates.bank_preferred` (legacy CSV free-text)

3. **Stored as a processor id; x1153 → `wires`.** The 5 labels map to processor
   ids (`higlobe/hurupay/jeeves/wise`), and `x1153` (a wire account) → `wires`.
   A saved `wires` therefore displays as "x1153" in this dropdown.

## Value mapping (dropdown label → stored `bank_preferred`)

| Dropdown label | Stored value |
|----------------|--------------|
| HiGlobe        | `higlobe`    |
| Hurupay        | `hurupay`    |
| Jeeves         | `jeeves`     |
| Wise           | `wise`       |
| x1153          | `wires`      |

## Implementation

**DB**
- `references/sql/alter/2026-07-22_add_bank_preferred_to_employee_ids.sql` — adds
  the column + CHECK constraint (`hurupay|wepay|higlobe|wise|jeeves|wires` or NULL).

**Data layer**
- `src/lib/supabase/employee-ids.ts` — added `bank_preferred` to `EmployeeIdRow`
  and to both `.select(cols)` strings so it is read back everywhere
  (`getEmployeeIds`, `getEmployeeIdRowByEmail`).

**UI** (`src/components/employee/EmployeeProfile.tsx`)
- New `bankPreferred` state, loaded from `bankInfo.bank_preferred` in both the
  load effect and `resetPayoutDraft` (validated via `isProcessorId`).
- The dropdown binds to `bankPreferred` / `setBankPreferred` — NOT
  `preferredProcessor`. Disabled with `payoutReadOnly`.
- Save POSTs `bank_preferred` alongside the other payout fields.

**Mapping helpers** (`src/lib/employee-payment-processors.ts`)
- `BANK_PREFERRED_OPTIONS`, `bankPreferredLabelForProcessor`,
  `processorForBankPreferredLabel`.

**API** (`app/api/update-employee-ids/route.ts`)
- `bank_preferred` added to the writable allowlist, validated against the
  processor set, and added to `BLOCKED_WHILE_PAYROLL_LOCKED` (it is a routing
  field, so it is also treated as a bank-change that notifies Accounting). The
  bootstrap-insert path already spreads `...update`, so new rows carry it.

**Dispatch precedence** (Bank Preferred wins) — three resolvers:
- `src/components/payroll-clerk/mock-queue.ts` — live queue bucketing.
- `src/lib/payroll/pay-schedule.ts` — `resolveEmployeeProcessor` (adds
  `bank_preferred` to the select, prefers it over `preferred_processor`).
- `src/lib/payroll/dispatch-export-csv.ts` — `buildDispatchExportRows` now takes
  the `employee_ids` rows and uses the employee choice as the fallback before the
  legacy rates CSV (recorded `dispatch.processor` still wins first). Its route
  (`app/api/payment-dispatches/reports/[cycleId]/export/route.ts`) fetches and
  passes the ids rows.

## Known wrinkle: `wires` ⇄ x1153 dual label (accepted)

`wires` and `x1153` collapse to one stored value. A saved `wires` displays as
"x1153" in this dropdown. The Disbursement radios independently show "Wires".

## Out of scope

- No change to the legacy `employee_hourly_rates.bank_preferred` column or the
  rates-sheet sync.

## Deploy note

Run `references/sql/alter/2026-07-22_add_bank_preferred_to_employee_ids.sql` in
the Supabase SQL editor before/at deploy. Until it runs, reads/writes of
`bank_preferred` will error (missing column).

## Verification

- `tsc --noEmit` passes clean.
- Mapping helpers round-trip for all 5 options + edge cases.
- Manual: changing Bank Preferred does NOT change the Disbursement selection;
  Save persists `bank_preferred`; reload shows the saved value.
