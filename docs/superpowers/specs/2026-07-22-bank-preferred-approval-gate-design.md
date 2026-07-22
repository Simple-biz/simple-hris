# Bank Preferred change — Accounting approval gate

**Date:** 2026-07-22
**Status:** Approved (pending written-spec review)

## Goal

When an employee changes their **Bank Preferred** value, the change must be
**approved by Accounting before it takes effect**. Until approved, the
employee's current approved value stays live for Payment Dispatch.

Builds on [2026-07-22-bank-preferred-dropdown-design.md] (the Bank Preferred
field itself). Mirrors the existing **MESA Requests** approval workflow.

## Decisions (from brainstorming)

1. **Pending state:** the CURRENT approved `employee_ids.bank_preferred` stays
   live for dispatch. The requested value is held pending and does not affect
   routing until Accounting approves.
2. **Scope:** only `bank_preferred` is gated. `preferred_processor`
   (Disbursement) and all account/email fields keep saving immediately.
3. **First-time set is gated too:** even the first Bank Preferred pick (from
   NULL) requires approval; until approved, dispatch falls back to
   `preferred_processor` / legacy.
4. **One pending request per employee:** re-submitting supersedes the previous
   pending request (old pending → superseded/denied, new pending inserted).
5. **Approver UI:** the "Issues" tab (internal id `disputes`), as a section
   ABOVE the existing PAB dispute queue. Approver gate =
   `requireFeatureEditAnyView('disputes')` (admin bypasses). No new permission.
6. **Employee side:** in-app notification on approve/deny, PLUS an inline
   status on the Bank Preferred field ("Pending: {value}" badge; clears on
   approve, reverts to old value on deny).

## Data model

New table `public.bank_preferred_change_requests`:

| column        | type / notes                                                      |
|---------------|-------------------------------------------------------------------|
| id            | uuid PK default gen_random_uuid()                                 |
| work_email    | text not null                                                     |
| employee_name | text                                                              |
| from_value    | text (current bank_preferred at request time; nullable)          |
| to_value      | text not null (requested processor id: higlobe/hurupay/jeeves/wise/wires) |
| status        | text not null default 'pending' CHECK IN ('pending','approved','denied','superseded') |
| review_notes  | text                                                              |
| reviewed_by   | text (approver session email)                                    |
| reviewed_at   | timestamptz                                                       |
| applied_at    | timestamptz (set when the value is written to employee_ids)      |
| created_at    | timestamptz default now()                                         |

- Partial unique index: `UNIQUE (work_email) WHERE status = 'pending'` — enforces
  one pending request per employee (supersede rule).
- `to_value` constrained to the processor id set (`hurupay|wepay|higlobe|wise|jeeves|wires`).
- Service-role only, no RLS (matches other request tables).

New notification type registered on `employee_notifications` CHECK:
`bank_preferred.decided` (single type; tone/title distinguishes approve vs deny),
via an ALTER mirroring `employee_notifications_add_bank_info_requested.sql`.

## Flow

### Employee submits (folded into existing Save)
`POST /api/update-employee-ids` (`app/api/update-employee-ids/route.ts`):
- After building `update` and loading `beforeRow`, and BEFORE writing
  `employee_ids`: remove `bank_preferred` from the immediate `update`.
- If requested `bank_preferred` != current `beforeRow.bank_preferred`:
  - mark any existing `pending` row for this `work_email` as `superseded`,
  - insert a new `pending` row (`from_value` = current, `to_value` = requested),
  - `notifyReviewers()` fanout (admin/accounting/ceo) — reuse existing helper,
  - do NOT write `bank_preferred` to `employee_ids`.
- If requested == current live value: no request (no-op).
- All other fields in the same request still write immediately.
- Response signals whether a bank-preferred request was created so the UI can
  toast "Bank Preferred change sent for approval".
- Bootstrap-insert path (brand-new employee_ids row): strip `bank_preferred`
  from the insert and file a pending request the same way (first-time gated).

### Accounting approves/denies
`PATCH /api/bank-preferred-requests/[id]` (mirror `mesa-requests/[id]` PATCH):
- gate `requireFeatureEditAnyView('disputes')`,
- **approve:** write `to_value` into `employee_ids.bank_preferred`; stamp
  `status='approved', reviewed_by, reviewed_at, applied_at`; write
  `bank_update_history` (via `insertBankUpdateHistory`, `via:'accounting_approval'`)
  so the People "Recent bank changes" feed reflects it; notify the employee
  (`bank_preferred.decided`, positive tone).
- **deny:** stamp `status='denied', reviewed_by, reviewed_at`; `employee_ids`
  untouched; notify the employee (`bank_preferred.decided`, neutral/negative).
- Guard: only a `pending` row can be approved/denied (mirror MESA's
  already-applied guard).

### List
`GET /api/bank-preferred-requests` (dual-mode, mirror mesa-requests GET):
- `?email=` → that employee's own requests (`authorizeEmailAccess`, self-or-elevated),
- no email → all (default pending) for accounting (`requireElevatedSession`),
- `?status=` filter supported.

## UI

- **Employee** (`src/components/employee/EmployeeProfile.tsx`):
  - On load, fetch the employee's latest bank-preferred request (`?email=`).
  - The dropdown value = current approved `bank_preferred`. If a pending request
    exists, show a "Pending approval: {label}" badge next to the field and keep
    the live value displayed. On deny the badge clears.
  - Save flow unchanged for the user; toast: "Bank Preferred change sent for
    approval" when a request was created.
- **Accounting** (`src/App.tsx` `disputes` case):
  - New `BankPreferredApprovals` component rendered ABOVE `<PabDisputeQueue />`.
  - Lists pending requests: employee, from → to (human labels via
    `bankPreferredLabelForProcessor`), created time, Approve / Deny buttons
    (Deny may capture an optional note). Refreshes after action.

## Files

**New**
- `references/sql/create/bank_preferred_change_requests.sql`
- `references/sql/alter/2026-07-22_employee_notifications_add_bank_preferred_type.sql`
- `app/api/bank-preferred-requests/route.ts` (GET list; POST optional/internal)
- `app/api/bank-preferred-requests/[id]/route.ts` (PATCH approve/deny)
- `src/components/payroll/BankPreferredApprovals.tsx`
- `src/lib/supabase/bank-preferred-requests.ts` (typed row + fetch/insert helpers)

**Modified**
- `app/api/update-employee-ids/route.ts` (intercept bank_preferred)
- `src/App.tsx` (render approvals section in `disputes` case)
- `src/components/employee/EmployeeProfile.tsx` (pending badge + fetch own request)

**Unchanged**
- Dispatch resolvers (mock-queue.ts, pay-schedule.ts, dispatch-export-csv.ts):
  they read `employee_ids.bank_preferred` directly, so gating the write is
  sufficient — no dispatch-side change.

## Deploy

Run in Supabase SQL editor (or applied directly via service role, as with the
column migration):
1. `references/sql/create/bank_preferred_change_requests.sql`
2. `references/sql/alter/2026-07-22_employee_notifications_add_bank_preferred_type.sql`

Ensure approvers have the "Issues" (disputes) feature granted (admin bypasses).

## Verification

- `tsc --noEmit` clean.
- Manual: employee changes Bank Preferred → live value unchanged, request
  appears pending in Issues tab, employee sees pending badge; approve → value
  live + notification + badge clears; deny → value unchanged + notification;
  re-submit supersedes prior pending.
