# Implementation Plan — PAB Day-Dispute System (Orphanage Visit + General Exceptions)

| | |
|---|---|
| **Owner** | Kane Reroma (sole assignee — requires existing PAB Calculator familiarity) |
| **Deadline** | 2026-05-01 |
| **Status** | Implemented (2026-04-16) |
| **Related** | `Documentation/problem.md` (PAB spec), `src/components/PayrollWizard.tsx:1246` (PAB eligibility), `src/components/employee/EmployeeDashboard.tsx:1731` (PAB calendar), `src/components/audit/AuditLogPanel.tsx`, `src/lib/pab-period-settings.ts` |

---

## 1. Context

Payroll requested a logic update: employees who work only 4 hours due to an orphanage visit should remain PAB-eligible. The exception applies on the day of or the day after the visit.

During design review, this expanded into a **general PAB day-dispute system**: employees click a failing day on their PAB calendar, select a reason (orphanage visit, medical, internet/power outage, family emergency, etc.), add an explanation, and submit for HR approval. Only HR-approved disputes affect PAB eligibility. Every action (submit, approve, deny) is audit-logged and surfaced on the admin dashboard.

### Why generalize

Building a single-purpose `orphanage_visits` table means rebuilding it the next time Payroll adds a new exception type. A reason-code-based dispute table costs ~2 extra days now and handles every future exception type with zero code changes — just a new reason code in `app_settings`.

---

## 2. Requirements

### Functional

1. **Employee-facing:** on the PAB calendar (Hours tab, `EmployeeDashboard.tsx:1731`), an employee can click any **red (failing) day** to open a dispute form.
2. **Dispute form** includes:
   - Reason dropdown with preset options (admin-configurable via `app_settings`).
   - Free-text explanation field (required for "Other", optional otherwise).
   - Default presets: `Orphanage visit`, `Doctor / medical`, `Internet outage`, `Power outage`, `Family emergency`, `Other`.
3. **Approval flow:** disputes start as `pending`. HR reviews in a queue on the admin side and sets `approved` or `denied` with an optional decision note.
4. **PAB eligibility integration:**
   - An `approved` dispute on a failing day changes the threshold from `≥ 7h` to `≥ 4h` (the "orphanage visit floor").
   - Different reason codes may have different hour floors in the future — for v1, all approved disputes use the same 4-hour floor.
   - `pending` and `denied` disputes have no effect on eligibility.
   - The "day of or day after" rule: an approved dispute covers `dispute_date` and `dispute_date + 1 calendar day`.
5. **Calendar cell states** update to reflect dispute status:
   - Amber = pending HR review.
   - Green with badge = approved (forgiven).
   - Red with badge = denied.
   - Clicking a disputed cell (any status) shows the dispute detail as read-only.
6. **Admin dashboard (Overview / Payroll Wizard):** surface pending dispute count as a card/badge so HR doesn't miss them.
7. **Audit log** records every state change with the existing `insertAuditLog` pattern.
8. **Employee dispute history panel** below the PAB calendar showing all their disputes with status.

### Non-functional

- Must not regress PAB behavior for employees with no disputes.
- Respects `pab_scope_department_keys` — disputes from out-of-scope departments don't affect PAB.
- Disputes are persistent (survive payroll re-runs).
- Reason codes are admin-configurable without a deploy.

### Out of scope (v1)

- Changing the 7-hour base threshold or the 4-hour forgiveness floor via UI.
- Auto-detection of dispute-worthy days (e.g., push notification to employee when a day fails).
- Tying disputes to the generalized "Individual Days Off" system from `problem.md`.

---

## 3. Current Architecture

| Component | File | What it does |
|---|---|---|
| PAB eligibility | `PayrollWizard.tsx:1246` | `perfectAttendanceEligible` — iterates `weekdayColumnGroups`, fails any day `< 7 * 3600` seconds. **Insertion point for dispute forgiveness.** |
| Per-day breakdown | `PayrollWizard.tsx:1297` | `employeeWeekdayHours` — stores `{ col, seconds, passes }` per weekday. Add `forgivenByDispute` flag here. |
| Employee PAB calendar | `EmployeeDashboard.tsx:1731` | Mon–Fri grid, color-coded. Red cells = failing. **Click target for dispute submission.** |
| PAB period settings | `pab-period-settings.ts` | Manual/auto PAB range, dept scope. Disputes reference the same range. |
| Audit log helper | `src/lib/supabase/audit-log.ts` | `insertAuditLog(...)` — existing pattern for all mutations. |
| Audit log panel | `src/components/audit/AuditLogPanel.tsx` | `formatActionLabel` + `actionDot` switch — **add new dispute action labels here.** |
| Admin dashboard | `src/components/Overview.tsx` | System overview. **Add pending-disputes count card here.** |

---

## 4. Data Model

### 4.1 New table: `pab_day_disputes`

```sql
CREATE TABLE public.pab_day_disputes (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  work_email      TEXT          NOT NULL,
  dispute_date    DATE          NOT NULL,
  reason          TEXT          NOT NULL,           -- 'orphanage_visit', 'medical', 'internet_outage', etc.
  explanation     TEXT,
  status          TEXT          NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'approved', 'denied')),
  decided_by      TEXT,                              -- admin name/email who approved/denied
  decided_at      TIMESTAMPTZ,
  decision_note   TEXT,                              -- optional HR note on decision
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by      TEXT,                              -- employee name/email who submitted
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- One dispute per employee per date
CREATE UNIQUE INDEX ux_pab_disputes_email_date
  ON pab_day_disputes (work_email, dispute_date);

-- Fast lookup: pending disputes for HR queue
CREATE INDEX ix_pab_disputes_status
  ON pab_day_disputes (status, created_at DESC);

-- Fast lookup: disputes within a PAB range for eligibility check
CREATE INDEX ix_pab_disputes_date_range
  ON pab_day_disputes (dispute_date, status);
```

**Notes:**
- `work_email` normalized by existing trigger (`public.normalize_email_column`). Attach it:
  ```sql
  DROP TRIGGER IF EXISTS trg_norm_email ON pab_day_disputes;
  CREATE TRIGGER trg_norm_email BEFORE INSERT OR UPDATE ON pab_day_disputes
  FOR EACH ROW EXECUTE FUNCTION normalize_email_column('work_email');
  ```
- Unique on `(work_email, dispute_date)` — one dispute per day per employee. Re-submitting requires deleting the existing one first.
- `reason` is free-text keyed to admin-configured values, not an enum — no migration needed for new reason codes.

### 4.2 Reason codes in `app_settings`

```sql
INSERT INTO app_settings (key, value) VALUES (
  'pab_dispute_reason_codes',
  '[
    {"code": "orphanage_visit",   "label": "Orphanage visit",    "min_hours": 4},
    {"code": "medical",           "label": "Doctor / medical",   "min_hours": 4},
    {"code": "internet_outage",   "label": "Internet outage",    "min_hours": 4},
    {"code": "power_outage",      "label": "Power outage",       "min_hours": 4},
    {"code": "family_emergency",  "label": "Family emergency",   "min_hours": 4},
    {"code": "other",             "label": "Other",              "min_hours": 4}
  ]'
);
```

Admin can edit this JSON in System Settings to add/remove reasons or change per-reason hour floors later.

---

## 5. Implementation Plan

### Phase 1 — Backend + API (day 1–3)

1. **Run the migration** (section 4.1 + 4.2) in Supabase.
2. **Create `src/lib/supabase/pab-day-disputes.ts`:**
   - `listDisputes(opts?: { email?, from?, to?, status? })` — fetches disputes, supports range filter for PAB period.
   - `createDispute({ work_email, dispute_date, reason, explanation })` — validates reason code against `app_settings`, inserts with `status='pending'`, calls `insertAuditLog` with action `pab_dispute.submitted`.
   - `decideDispute(id, { status, decided_by, decision_note })` — sets approved/denied, calls `insertAuditLog` with action `pab_dispute.approved` or `pab_dispute.denied`.
   - `deleteDispute(id)` — only allowed while `status='pending'`, calls `insertAuditLog` with action `pab_dispute.withdrawn`.
3. **Create `app/api/pab-disputes/` routes:**
   - `GET` — list (with query params: `email`, `from`, `to`, `status`).
   - `POST` — create (employee-facing).
   - `PATCH /[id]/decide` — approve/deny (admin-only).
   - `DELETE /[id]` — withdraw pending dispute (employee-only, own disputes).
4. **Fetch reason codes** via existing `/api/app-settings?key=pab_dispute_reason_codes`.

### Phase 2 — PAB Calculator Integration (day 3–4)

1. **Fetch approved disputes for the active PAB range** inside `PayrollWizard.tsx`. Store as `Map<normalizedEmail, Set<isoDateString>>` containing every `dispute_date` AND `dispute_date + 1 day`.
2. **Modify `perfectAttendanceEligible`** (`PayrollWizard.tsx:1246`):
   - Extract the `< 7 * 3600` check into a helper.
   - A weekday group passes if:
     - `seconds >= 7 * 3600` (normal pass), OR
     - the column's date is in the employee's forgiven-dates set AND `seconds >= 4 * 3600` (dispute pass).
3. **Extend `employeeWeekdayHours`** with `forgivenByDispute: boolean`.
4. **Badge in the PA cell** (Step 3 table): small chip on forgiven days with tooltip showing reason.

### Phase 3 — Employee Dashboard (day 4–6)

1. **Make red cells clickable** in the PAB calendar (`EmployeeDashboard.tsx:1770`). On click, open a `<DisputeDialog>`.
2. **`DisputeDialog` component** (`src/components/employee/DisputeDialog.tsx`):
   - Fetches reason codes from `app_settings`.
   - Shows quick-select chips + dropdown + explanation textarea.
   - "Other" requires explanation; named reasons seed a template.
   - Submit calls `POST /api/pab-disputes`.
   - Re-clicking a disputed cell opens the same dialog in read-only mode with status + HR decision.
3. **Calendar cell state updates:**
   - Fetch employee's disputes for the current PAB range on mount.
   - Overlay dispute status on each cell:
     - `pending` → amber border + clock icon.
     - `approved` → green border + star badge.
     - `denied` → red border + exclamation badge.
4. **Legend update** — add Pending / Forgiven / Denied entries.
5. **"My disputes" panel** below the calendar — chronological list of the employee's disputes with status badges.

### Phase 4 — HR Admin Queue (day 6–8)

1. **Payroll Wizard tab: "PAB Disputes"** (extracted to `src/components/payroll/PabDisputeQueue.tsx`):
   - Table: `Employee | Date | Reason | Hours worked | Explanation | Status | Actions`.
   - Filter: `All / Pending / Approved / Denied`.
   - Pending rows show `[Approve] [Deny]` buttons → opens a small confirmation dialog with optional decision note.
   - Approved/denied rows show the decision details (who, when, note).
2. **Pending count badge** on the tab label (e.g., "PAB Disputes (3)").

### Phase 5 — Admin Dashboard + Audit Log (day 8–9)

1. **Overview card** (`src/components/Overview.tsx`):
   - New card: "PAB Disputes" showing:
     - Pending count (amber).
     - Approved this period (green).
     - Denied this period (red).
   - Click navigates to the Payroll Wizard disputes tab.
2. **Audit log integration** (`src/components/audit/AuditLogPanel.tsx`):
   - Add to `formatActionLabel`:
     ```
     case 'pab_dispute.submitted':  → "PAB dispute filed: {employee} — {reason} on {date}"
     case 'pab_dispute.approved':   → "PAB dispute approved: {employee} {date} by {decided_by}"
     case 'pab_dispute.denied':     → "PAB dispute denied: {employee} {date} by {decided_by}"
     case 'pab_dispute.withdrawn':  → "PAB dispute withdrawn: {employee} {date}"
     ```
   - Add to `actionDot`:
     ```
     'pab_dispute.submitted'  → 'bg-amber-500'
     'pab_dispute.approved'   → 'bg-green-600'
     'pab_dispute.denied'     → 'bg-rose-600'
     'pab_dispute.withdrawn'  → 'bg-zinc-500'
     ```
3. **Audit log `details` payload** for each action:
   ```json
   {
     "employee": "john@simple.biz",
     "dispute_date": "2026-04-10",
     "reason": "orphanage_visit",
     "status": "approved",
     "decided_by": "Fran M",
     "decision_note": "Confirmed with team lead"
   }
   ```

### Phase 6 — Polish + Testing (day 9–10)

- Manual test matrix (section 7).
- Confirm audit entries render correctly in the panel.
- Confirm Overview card counts match the disputes tab.
- Edge case: employee submits dispute, HR denies, employee re-submits (must delete first → audit trail preserved).

---

## 6. Open Questions

1. **"Day of or day after" — calendar days or business days?** Friday visit → exception on Fri+Sat (calendar) or Fri+Mon (business)? Assuming calendar days.
2. **4-hour floor — per-reason or global?** Plan stores per-reason `min_hours` in the reason-code JSON but v1 uses 4h for all. Confirm this is correct.
3. **Can employees dispute green (passing) days?** Probably not — but should we allow it for documentation purposes (e.g., "I had a visit but still hit 7h")? Assuming no.
4. **Can employees edit a pending dispute?** Plan says delete + re-create. Simpler than edit states.
5. **Auto-withdraw on re-upload?** If HR re-uploads Hubstaff data and a previously failing day now passes (≥ 7h), should pending disputes for that day auto-withdraw? Assuming no (manual cleanup).
6. **Notification when HR decides?** Toast on next employee login, or no notification? Assuming no push for v1; employee checks their dispute history.

---

## 7. Test Plan

| # | Scenario | Expected |
|---|---|---|
| 1 | Employee clicks red cell (4.2h), submits orphanage visit | Dispute created as `pending`. Cell turns amber. Audit log: `pab_dispute.submitted`. |
| 2 | HR approves the dispute | Status → `approved`. Cell turns green with badge. PAB recalculates: day passes at 4h floor. Audit log: `pab_dispute.approved`. |
| 3 | HR denies a dispute with note | Status → `denied`. Cell stays red with `!` badge. Tooltip shows denial reason. Audit log: `pab_dispute.denied`. |
| 4 | Employee withdraws pending dispute | Dispute deleted. Cell reverts to red. Audit log: `pab_dispute.withdrawn`. |
| 5 | Employee tries to dispute a green (passing) cell | Click disabled or no dispute dialog shown. |
| 6 | Dispute on `visit_date + 1` — employee's short day is the day after | PAB forgives day-after if approved. |
| 7 | Dispute on `visit_date + 2` | No forgiveness (out of window). PAB fails. |
| 8 | Employee works 3h on a disputed day (below 4h floor) | Even if approved, PAB fails (below minimum). |
| 9 | Two disputes same date same employee | Unique-index error, UI prevents double-submit. |
| 10 | Dispute for employee outside PAB dept scope | Dispute stored but ignored during PAB calc. |
| 11 | Audit log shows all 4 action types | `submitted`, `approved`, `denied`, `withdrawn` render with correct labels and dot colors. |
| 12 | Overview card shows correct counts | Pending/approved/denied counts match the disputes tab. |
| 13 | Mixed-case email `Jane@Simple.biz` | Email trigger normalizes; dispute matches PAB row. |

---

## 8. Rollout

1. Run SQL migration in Supabase (table + indexes + trigger + reason codes).
2. Deploy backend (API routes + lib) behind feature flag `pab_disputes_enabled` in `app_settings`.
3. Deploy employee-facing calendar + dispute dialog (reads the flag).
4. Deploy HR admin queue in Payroll Wizard.
5. Deploy audit log labels + Overview card.
6. Enable flag for HR team, dogfood for 1 PAB cycle.
7. If green: remove flag, document in `BUSINESS_LOGIC.md`.

---

## 9. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Employee abuse (disputing every short day as "orphanage visit") | Inflated PAB payouts | HR approval gate; audit log traces every submission; per-reason `min_hours` floor prevents 0-hour abuse. |
| HR ignores pending queue | Disputes sit in limbo, employees frustrated | Overview card + badge count on the tab; consider Slack/email notification in v1.1. |
| "Day after" ambiguity → wrong date disputes | Employee disputes wrong day | UI shows both covered dates explicitly: "This dispute covers Wed Apr 10 and Thu Apr 11." |
| Reason code typo in `app_settings` JSON | Disputes fail validation | Validate JSON schema on save in System Settings; fallback to hardcoded defaults if parse fails. |
| 6.5k-line PayrollWizard grows further | Dev velocity hit | HR queue extracted to `src/components/payroll/PabDisputeQueue.tsx`; dispute dialog extracted to `src/components/employee/DisputeDialog.tsx`. |

---

## 10. Deliverables Checklist

- [x] SQL migration: `pab_day_disputes` table + indexes + email trigger
- [x] `app_settings` seeded with `pab_dispute_reason_codes`
- [x] `src/lib/supabase/pab-day-disputes.ts` — CRUD + audit log
- [x] `app/api/pab-disputes/` — GET / POST / PATCH / DELETE routes
- [x] `src/components/employee/DisputeDialog.tsx` — employee dispute form
- [x] Employee PAB calendar: clickable red cells + amber/green/red dispute states
- [ ] Employee "My disputes" history panel (deferred to v1.1)
- [x] `perfectAttendanceEligible` updated with dispute forgiveness logic
- [x] `employeeWeekdayHours` extended with `forgivenByDispute`
- [x] `src/components/payroll/PabDisputeQueue.tsx` — HR review queue
- [x] Disputes sidebar tab wired to PabDisputeQueue (instead of Payroll Wizard sub-tab)
- [ ] Overview card: pending / approved / denied counts (deferred to v1.1)
- [x] `AuditLogPanel.tsx`: 4 new action labels + dot colors
- [ ] Manual test matrix executed
- [x] `BUSINESS_LOGIC.md` updated with dispute rules
- [x] `memory/pending_sql.md` updated
