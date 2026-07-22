# Bank Preferred dropdown — Employee Dashboard → Profile → Payment

**Date:** 2026-07-22
**Status:** Approved

## Goal

Add a small **"Bank Preferred"** section below the existing payment form on the
Employee Dashboard Profile → Payment tab, with a single dropdown offering:
**HiGlobe, Hurupay, Jeeves, Wise, x1153**. The employee's choice drives where
payroll routes their salary (Payment Dispatch).

## Key decisions (from brainstorming)

1. **It IS the routing choice — a reskin of the existing picker.** The dropdown
   reads and writes the *same* state as the existing radio picker:
   `preferredProcessor` / `setPreferredProcessor` in `EmployeeProfile.tsx`
   (currently bound at lines 1806–1807). Because both controls share one piece
   of React state, they mirror automatically — no separate sync code.

2. **No new column, no API change, no dispatch change.** Saving continues to
   POST `preferred_processor` to `/api/update-employee-ids`. Payment Dispatch
   already prefers `employee_ids.preferred_processor` over the legacy CSV
   `employee_hourly_rates.bank_preferred`:
   - `src/components/payroll-clerk/mock-queue.ts:342-344`
   - `src/lib/payroll/pay-schedule.ts:106-126`
   So picking a channel here already routes the employee in dispatch.

3. **Exactly the 5 requested options; x1153 → `wires`.** `preferred_processor`
   has no `x1153` value, so x1153 (a wire account) maps to `wires`.

## Value mapping (dropdown label → saved `preferred_processor`)

| Dropdown label | Saved `preferred_processor` |
|----------------|-----------------------------|
| HiGlobe        | `higlobe`                   |
| Hurupay        | `hurupay`                   |
| Jeeves         | `jeeves`                    |
| Wise           | `wise`                      |
| x1153          | `wires`                     |

## Known wrinkle: `wires` ⇄ x1153 dual label (accepted)

`wires` and `x1153` collapse to the same saved value. When the saved value is
`wires`, this dropdown displays **"x1153"** (its only `wires` option), while the
existing radio picker displays **"Wires"** — same underlying value, two labels.
For kaner (whose `preferred_processor` is already `wires`) the dropdown reads
x1153 and the radios read Wires. This is inherent to folding a specific wire
account and the generic Wires processor into one field. Mitigation: a one-line
caption under the dropdown clarifying it routes salary through this channel.

## Retired processors (Jeeves, Wise) re-exposed (accepted)

Jeeves and Wise are in `RETIRED_PROCESSOR_IDS`; the radio picker hides them
unless already selected. This dropdown re-exposes them as choices (user chose
"exactly your 5"). Selecting one sets `preferred_processor` to that retired id;
the radio picker's existing fallback (`employee-payout-fields.tsx:236-238`) then
shows that tile because it is the current selection, and its detail fields
render normally.

## Implementation

- **File:** `src/components/employee/EmployeeProfile.tsx`
  - `SmoothSelect`, `PROCESSOR_OPTIONS`, `ProcessorId`, and `payoutReadOnly` are
    already imported / in scope.
  - Insert a new small section immediately **after** the Disbursement `Section`
    closes (currently line 1819), before the "Selected channel" caption block.
  - The dropdown:
    - Options: the 5 labels above, in the requested order.
    - `value`: derived from `preferredProcessor` via a label lookup
      (`wires` → the "x1153" option).
    - `onChange`: maps the chosen option id back to a `ProcessorId` and calls
      `setPreferredProcessor(...)`.
    - `disabled={payoutReadOnly}` — matches the radios (locked/read-only).
    - A short helper caption under it.
- **Mapping helper:** a small local const/array (label ↔ processor id) kept in
  the component file (or a tiny addition to
  `src/lib/employee-payment-processors.ts` if cleaner). Single source for both
  directions.

## Out of scope

- No DB migration.
- No change to `/api/update-employee-ids`.
- No change to Payment Dispatch, pay-schedule, or the rates-sheet sync.
- No change to the legacy `employee_hourly_rates.bank_preferred` column.

## Testing / verification

- Type-check passes (`tsc`), build lints clean.
- Manual: on the Payment tab, changing the dropdown updates the radio selection
  and detail fields, and vice versa; Save persists `preferred_processor`.
- Regression sanity: kaner's saved `wires` shows as "x1153" in the dropdown and
  "Wires" in the radios (documented dual label).
