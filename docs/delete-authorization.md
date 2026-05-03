# Delete Authorization Policy

*Added 2026-05-02. Covers the destructive-delete actions on `pab_day_disputes` and `leave_requests`.*

Some accounting tasks require permanently removing records: a duplicate dispute filed by mistake, a malformed leave request that needs to be re-entered, etc. Approve/deny keeps the audit trail intact, but those don't physically remove rows. The two delete paths below let authorized users wipe records, with role gates and audit logging proportional to the destructiveness.

---

## PAB Day Disputes

**Endpoint:** `DELETE /api/pab-disputes/[id]?mode=admin`
**UI entry point:** trash icon button on each row in `PabDisputeQueue`.

### Roles allowed

Defined in `src/lib/supabase/pab-day-disputes.ts` as `DISPUTE_DELETE_ROLES`:

```ts
export const DISPUTE_DELETE_ROLES: readonly string[] = [
  'payroll_manager',
  'admin',
];
```

Intentionally tighter than `DISPUTE_ACTOR_ROLES` (which controls approve/deny):

| Role | Can approve/deny | Can delete |
|---|---|---|
| `admin` | ✅ | ✅ |
| `payroll_manager` | ✅ | ✅ |
| `payroll_coordinator` | ✅ | ❌ |
| `finance` | ✅ | ❌ |
| `hr_coordinator` | ✅ | ❌ |

### Behavior

- Works on disputes in any status (pending, approved, denied, accounting_*, …)
- No email-match check — accounting can delete any employee's dispute
- Hard delete; the row is removed from `pab_day_disputes`

### Audit log

Action: `pab_dispute.admin_deleted`. Snapshot includes the prior `status`, `decided_by`, `decision_note`, plus the dispute's employee + date + reason — so deletions remain traceable after the row is gone.

The pre-existing `pab_dispute.withdrawn` action covers the legacy employee-self-withdraw path on `?employee_email=…` (only works on pending disputes, currently disabled in the UI per `docs/orphanage-dispute-flow.md`).

---

## Leave Requests

**Endpoint:** `DELETE /api/leave-requests/[id]`
**UI entry point:** trash icon button on each row in `LeaveRequestsPanel`. Same component is mounted by both the **Accounting** dashboard (`/`) and the **Manager** dashboard (`/manager`).

### Roles allowed

Defined in `src/lib/supabase/leave-requests.ts`:

```ts
export const LEAVE_DELETE_ROLES: readonly string[] = [
  'payroll_manager',
  'admin',
  'manager',
];

export const LEAVE_DELETE_UNRESTRICTED_ROLES: readonly string[] = [
  'payroll_manager',
  'admin',
];
```

| Role | Scope |
|---|---|
| `admin` | **Unrestricted** — any request, any department |
| `payroll_manager` | **Unrestricted** — any request, any department |
| `manager` | **Scoped** — only requests for departments they actively manage |

Other accounting roles (`payroll_coordinator`, `finance`, `hr_coordinator`) cannot delete leave requests.

### Manager scope check

For `manager` (i.e. the role is in `LEAVE_DELETE_ROLES` but **not** in `LEAVE_DELETE_UNRESTRICTED_ROLES`), the API performs a per-row authorization via `isAuthorizedLeaveApprover()` — the same chain used by `PATCH /api/leave-requests/[id]` for approve/reject. The actor must satisfy at least one of:

1. Listed in the request's stored `manager_email` (comma-joined).
2. Currently active manager for the request's department (via `department_managers`).
3. Listed in the legacy `leave_department_managers_json` map for the department.
4. Listed in `leave_accounting_notify_emails` or `leave_approver_emails` settings.

A manager who tries to delete a request in a department they don't manage gets a `403`.

### Audit log

Action: `leave.admin_deleted`. The `details` payload includes:

- `scope`: `'unrestricted'` (admin / payroll_manager) or `'department'` (manager) — useful when reviewing who's purging what.
- `prior_status`, `prior_approver`, `prior_approver_note`
- `employee_email`, `employee_name`, `department`, `leave_type`, `start_date`, `end_date`

The pre-existing `leave.cancelled` action covers the employee-initiated cancellation path through `PATCH { action: 'cancel' }`. Cancel only works on pending rows and only for the employee who filed the request.

---

## Code map

| File | Role |
|---|---|
| `src/lib/supabase/pab-day-disputes.ts` | `DISPUTE_DELETE_ROLES`, `adminDeleteDispute()` |
| `app/api/pab-disputes/[id]/route.ts` | DELETE handler — Mode A (employee withdraw) and Mode B (admin delete) |
| `src/components/payroll/PabDisputeQueue.tsx` | Trash button + confirmation dialog; `canDelete` derived from `/api/employee-roles` |
| `src/lib/supabase/leave-requests.ts` | `LEAVE_DELETE_ROLES`, `LEAVE_DELETE_UNRESTRICTED_ROLES`, `adminDeleteLeaveRequest()`, `isAuthorizedLeaveApprover()` |
| `app/api/leave-requests/[id]/route.ts` | DELETE handler — admin/payroll_manager unrestricted, manager scoped |
| `src/components/LeaveRequestsPanel.tsx` | Trash button + confirmation dialog; `canDelete` derived from `/api/employee-roles` |

---

## Adjusting the policy

To broaden either policy (e.g. let `payroll_coordinator` delete disputes), edit the relevant constant in the lib file. The UI (`canDelete` flag) and API (role gate) both read from the same constant, so the change is one line.

Don't widen the unrestricted leave tier (`LEAVE_DELETE_UNRESTRICTED_ROLES`) without thinking — it lets a role bypass the per-department scope check. The current set (admin + payroll_manager) is intentionally narrow for cross-department wipes.
