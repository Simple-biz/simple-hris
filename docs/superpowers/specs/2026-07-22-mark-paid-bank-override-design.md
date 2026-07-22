# Mark Paid modal: bank-details override (write-back to employee profile)

**Date:** 2026-07-22
**Status:** Approved

## Problem

The Payment Dispatch → Mark Paid modal prefills its Recipient fields (Bank,
Account holder, Account / wallet ID, SWIFT) from the employee's dashboard data
(`employee_ids`, via the queue row's `details` and `resolveMarkPaidDefaults`).
The clerk can type corrections, but they only land in the dispatch log
(`payment_dispatches`) — the employee's stored details stay wrong. Accounting
wants an edit icon in the modal that pushes the corrected details back to the
employee's profile, overriding what the employee entered, so the dashboard
reflects what their bank actually IS.

## Decisions (user-confirmed)

1. **Immediate save** — the pencil enters an explicit "override mode" with its
   own **Save to profile** action. The write happens right away, independent of
   whether the dispatch is confirmed or cancelled. Typing without pressing the
   pencil keeps today's log-only behavior.
2. **Notify the employee** — a bell notification ("Accounting updated your bank
   details") fires on every override. The change also always appears in
   People → Bank Changes and the audit log.

## Approach

Dedicated accounting-only endpoint. `/api/update-employee-ids` is NOT reused:
it hard-blocks bank-field writes while the payroll dispatch lock is on (423) —
and Mark Paid is used exactly during processing — and it logs
`via: "employee_dashboard"` + notifies reviewers, both wrong for an accounting
correction. Routing (`employee_ids.bank_preferred`) is never touched — this
feature edits receiving-end details only.

## UI — `MarkPaidDialog.tsx`

- Pencil icon on the right end of the "Recipient" divider.
- Pressing it enters **override mode**:
  - Amber badge on the divider: "Editing employee profile".
  - The SAME four recipient inputs are used (no duplicate fields); whatever is
    currently typed is what saves.
  - Fields that don't apply to the current display (see mapping) become
    read-only with a dim hint.
  - Two inline actions appear below the recipient fields: **Save to profile**
    and **Cancel**. Cancel restores the values from before the pencil was
    pressed and exits override mode.
- On successful save: success toast, exit override mode, optional
  `onBankDetailsOverridden?: () => void` prop fires so the parent can silently
  refetch the queue. Prop is optional — `PayrollDispatch` wires it;
  `PayrollClerkApp` / `UrgentPaymentsQueue` render sites are untouched.
- On failure: error toast, stay in override mode (values preserved).
- Save is disabled while the Account / wallet ID value is empty, and while a
  save is in flight.

## What saves, per what the modal is showing

The client derives `target` from what it displayed (the same logic as
`resolveMarkPaidDefaults`): `'bank'` when showing wire details
(wires / Jeeves / Wise-routed employee with own-bank details), `'wallet'`
otherwise.

| Display | Editable fields | Columns written |
|---|---|---|
| bank (wires / jeeves / wise-with-bank) | Bank, Holder, Account, SWIFT | slot-aware: primary → `bank_name`, `account_holder_name`, `account_number`, `swift_code`; alternative → `alt_bank_name`, `alt_account_holder_name`, `alt_account_number`, `alt_routing_number` |
| wallet, hurupay | Account / wallet ID only | `hurupay_email` |
| wallet, wepay | Account / wallet ID only | `wepay_email` |
| wallet, higlobe | Account / wallet ID + Holder | `higlobe_email`, `higlobe_account_name` |
| wallet, wise | Account / wallet ID + Holder | `wise_email`, `account_holder_name` |

The **server** owns the column mapping (incl. reading `preferred_bank_slot` to
pick primary vs alternative) — the client only sends semantic values.

## API — `POST /api/payment-dispatch/bank-override`

- **Gate:** `requireFeatureEdit("accounting", "payment_dispatch")` — same as
  the dispatch save API. No dispatch-lock check: this is the sanctioned
  mid-processing correction path.
- **Body:** `{ work_email, target: 'bank' | 'wallet', processor, values: { preferredBank?, accountNumber, accountHolder?, swiftCode? }, display_name? }`
- **Behavior:**
  1. Validate gate, body shape, non-empty `work_email` + `accountNumber`.
  2. Load the current `employee_ids` row (snapshot the before values of the
     columns about to be written). If no row exists (person only in the rates
     CSV), bootstrap one (same `SELF-…` employee_id pattern as the
     bank-preferred approval route).
  3. Map `target`/`processor`/slot → columns; single UPDATE (or INSERT).
  4. Best-effort (never fails the save):
     - `insertBankUpdateHistory` with `via: 'mark_paid_override'`, masked
       before→after per field (reuse `maskFieldValue`) → shows in
       People → Bank Changes.
     - `insertAuditLog` (`action: 'bank_override.saved'`, actor from session).
     - `pulseBankChanges()` so the feed updates live.
     - Employee notification insert (`type: 'people.banking.overridden'`,
       title "Accounting updated your bank details", message naming the fields
       changed, no raw values).
  5. Return `{ success: true }` or `{ error }` with proper status.

### Migration

`employee_notifications.type` has a CHECK constraint, so the new
`people.banking.overridden` type needs
`references/sql/alter/2026-07-22_employee_notifications_add_bank_override_type.sql`
(run manually in the Supabase SQL editor, like the outstanding bank-preferred
type migration). Until it runs, the notification insert fails silently
(best-effort) — the override itself still saves.

## Error handling

- 401/403 from the gate → surfaced as toast.
- Supabase write error → 500 with message, modal stays in override mode.
- No partial writes: one UPDATE statement covers all mapped columns.

## Testing

- Unit tests for the server column mapping: target × processor × slot matrix
  (mirrors the style of `mark-paid-defaults.test.ts`).
- Existing `resolveMarkPaidDefaults` tests unchanged (read path untouched).

## Out of scope

- Changing routing / `bank_preferred` from the modal.
- Editing the alternative slot when the active slot is primary (only the
  ACTIVE slot is written).
- The dispatch-log fields' existing behavior (unchanged).
