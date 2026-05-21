# Implementation Plan — HR Dashboard (Onboarding + Offboarding)

> Source: discussion between **Kane R** and **Teal Crowley**.
> Goal: replace the spreadsheet-heavy HR workflow with a first-class HR dashboard that becomes the single source of truth for the **Global Master List** — feeding Payroll (Hero), Orphanage, and Accounting downstream.

| | |
|---|---|
| **Owner** | Kane Reroma (engineering) · Teal Crowley + John (HR domain) |
| **Status** | Phase 0 complete — HR view shell scaffolded (`/hr` route, sidebar, view-switcher entry, profile-photo unification across all role views) |
| **Next phase** | Phase 1 — Onboarding "Add person" form wired into Global Master List |
| **Related code** | `app/hr/page.tsx`, `src/components/hr/HrApp.tsx`, `src/components/hr/HrSidebar.tsx`, `src/lib/rbac/views.ts`, `src/lib/supabase/employees.ts`, `src/hooks/useViewerProfilePhoto.ts` |
| **Related docs** | [`business-logic.md`](./business-logic.md), [`csv-imports.md`](./csv-imports.md), [`data-sources.md`](./data-sources.md), [`implementation-plan-orphanage-visit-pab.md`](./implementation-plan-orphanage-visit-pab.md) |

---

## 1. Context & Goals

### 1.1 Why this exists

The Payroll Dashboard ("Hero") computes hours and rates from Hubstaff reports + rate sheets. To produce correct payroll the system needs a **trustworthy, unified employee roster** for every team — not just Legion.

The **Global Master List** is meant to be that roster: every hired person across every team. Today it is maintained manually by HR (specifically John) on Mondays, after a multi-step relay across spreadsheets. This dashboard moves that work into the app and makes the master list the authoritative source for payroll, attendance, and orphanage flows.

### 1.2 Unification objective

Single source of truth for active employees:

```
                 ┌────────────────────────┐
  HR Dashboard →   global_master_list      ← (current spreadsheet)
                 │   active_employees view  │
                 └────────────┬─────────────┘
                              │
                              ▼
        ┌──────────────┬──────────────┬──────────────┐
        │   Payroll    │  Orphanage   │  Accounting  │
        │   (Hero)     │   manager    │   PAB / pay  │
        └──────────────┴──────────────┴──────────────┘
```

Today HR is the *last touch* on the master list. The HR dashboard makes HR the *only touch*.

---

## 2. Current State (as discussed)

### 2.1 Onboarding relay (today)

| Step | Owner | System |
|---|---|---|
| 1. Capture new hire (name, personal email, location, phone, interview date, source) | Recruitment | **New Hire Checklist** (spreadsheet) |
| 2. Create `@simple.biz` work email and write it back to the checklist (Fri/Sat) | Payroll | Google Workspace + checklist |
| 3. Confirm orientation attendance (input from Jackie) | HR (Mon) | Email / chat |
| 4. Transfer row from checklist → Global Master List | **John (HR)** | **Global Master List** (spreadsheet) |

Volume notes:
- **Legion** can hire **up to ~75 people in one week** — bulk entry is required.
- **AI / API** teams hire in trickles; new hires often arrive as a forwarded email to Teal and are typed in by hand.

### 2.2 Offboarding relay (today)

| Step | Owner | System |
|---|---|---|
| 1. Email list of off-boarded personnel (name, email, start date, off-board date, reason) | Jackie → Teal | Email |
| 2. Auto-deactivate work account + send termination email to personal address | **Drew's existing automation** | Google Workspace |
| 3. Manually pull from recruitment spreadsheet → remove/mark row in Global Master List | John (HR) | Spreadsheet |

### 2.3 Constraint: HR does not own attendance

Attendance is forwarded to **Jackie or the team managers** — *not* HR. The HR dashboard must not absorb attendance review; it should only own the roster. (Attendance + PAB live in their respective Manager / Orphanage / Accounting flows — see [`implementation-plan-orphanage-visit-pab.md`](./implementation-plan-orphanage-visit-pab.md).)

---

## 3. Onboarding — Dashboard Requirements

### 3.1 "Add person" flow

A primary action button labeled **"Add person"** (or "Add employee") on the HR dashboard opens an input form. Used by **Teal** for AI/API team additions and **John** for the Monday Legion batch.

**Required fields** (mirrors what's already on the Global Master List + checklist):

- Full name
- Personal email
- Department / Team (drop-down — see 3.2)
- Job description
- Start date
- Source (where the hire came from)
- Phone number, location (carry-over from checklist)
- Work email (`@simple.biz`) — *populated later, see 3.4*

### 3.2 Department drop-down → rate pre-fill

Selecting a Team / Department / Job Description must:

1. Pre-fill **Regular Rate** from the canonical rate source (the same `employee_hourly_rates` / Rates Google Sheet feeding payroll today — see [`data-sources.md`](./data-sources.md) → "Rates").
2. Pre-fill **Overtime Rate** the same way.
3. Allow either rate to be **manually overridden** (custom rate exceptions are a real case).

### 3.3 Bulk entry (Legion Monday batch)

Up to **75 rows in a session** must be possible without it feeling painful. Approach options for Phase 1:

- (A) Repeating **single-entry form** with auto-clear and a running counter.
- (B) **Tabular bulk-entry mode** (paste-from-spreadsheet friendly) feeding the same validation as the single form.
- (C) **CSV import** of the New Hire Checklist sheet into a staged review screen, then bulk commit.

Recommend Phase 1 = (A) + (C) for the realistic Monday workflow. (B) is a Phase 2 enhancement if (A) feels slow in practice.

### 3.4 Work email integration

Payroll continues to mint `@simple.biz` accounts on Friday / Saturday. The HR dashboard must:

- Allow **draft** entries that are missing a work email (status: `pending_work_email`).
- Surface a "Needs work email" filter on the roster view.
- Provide a quick **"Set work email"** action so John can paste the address once Payroll publishes it.
- Mark the entry **active** (and therefore visible to `active_employees`) once name + personal email + work email + start date are all present.

#### Auto-suggestion + availability *(shipped 2026-05-20; alternate-conflict + reuse note 2026-05-21)*

The "Set work email" dialog (and the onboarding `set-work-email` route) auto-suggests an `@simple.biz` address and checks availability via `POST /api/hr/work-email/suggest`. Logic split across `src/lib/hr/work-email.ts` (pure) and `src/lib/hr/work-email-server.ts` (DB):

- **Minting rule** (`suggestWorkEmail`): local part = first name + first letter of last name (`Kane Reroma` → `kaner`). The full name is one field — the first whitespace token is the first name, the **last** token the last name (`Jane Dela Cruz` → `janec`). On a collision it **lengthens the surname slice one letter at a time** (`kaner` → `kanere` → `kanerer`), and only if the whole surname is exhausted does it fall back to a numeric suffix (`kanereroma2`).
- **Taken set** (`loadTakenWorkEmails`): the addresses a new mint must avoid —
  - every non-off-boarded `global_master_list` `Work Email`, **plus that row's `Alternate Work Email` / `Alternate Work Email 2`** *(added 2026-05-21)* so a fresh address can never collide with an existing alias;
  - every in-flight `hr_pending_employees` `work_email` (status `pending_work_email` | `ready`).
- **Off-boarded addresses are reusable**: off-boarded rows are skipped entirely, freeing their primary **and** alternate addresses for recycling (per HR). Both the Add Person and onboarding "Set work email" surfaces show a reminder to that effect.

### 3.5 Data destination

The HR dashboard writes to the existing `global_master_list` table (the underlying source for the `active_employees` view used by every other dashboard — see `src/lib/supabase/employees.ts`). **No parallel HR table.** Anything new (e.g., `source`, `phone`, `location`) extends `global_master_list` so payroll/manager/orphanage flows see the same row.

---

## 4. Offboarding — Dashboard Requirements

### 4.1 Find the person

A **search bar** on the HR roster page allows John to look up an employee by name, work email, personal email, or department. Result list shows a row per match with a row-level action button (mirrors the existing "View" pattern elsewhere in the app).

### 4.2 "Off Board" trigger

Each row gets an **"Off Board"** button (placed next to or replacing the existing per-row "View" affordance for HR). Pressing it opens a confirmation dialog asking for:

- **Off-boarding date** (defaults to today)
- **Reason** — a controlled list so reporting works (`resigned`, `performance`, `time_manipulation`, `attendance`, `end_of_contract`, `other` + free-text note)

### 4.3 Workflow trigger (Drew's automation)

The "Off Board" confirm action is the **single trigger** for the existing automation:

- Deactivate / delete the `@simple.biz` work email account.
- Send termination notice to the personal email address on file.

The dashboard fires the automation (via webhook / queue / direct API — TBD with Drew), then marks the row in `global_master_list` as off-boarded with the captured date + reason.

**Optional** confirmation toast / inbox notification once the automation reports success — nice-to-have, not blocking for Phase 1.

### 4.4 Data retention rules

> **Off-boarded data must be retained, not deleted.**

- Row stays in `global_master_list`.
- Active-employee surface (the `active_employees` view) excludes off-boarded rows from payroll, manager, and orphanage flows automatically — same way it filters today.
- Off-boarding reason is **persisted** (not just emailed around) so HR can run attrition / reason-mix reporting against it.
- Off-boarded employees remain searchable on the HR dashboard (with a clear "Off-boarded · {date} · {reason}" badge) so HR can answer follow-up questions weeks later.

---

## 5. Integration Points (out of HR's domain, but on the unified data set)

### 5.1 Attendance / Hubstaff

HR does not own this. Attendance lands with **Jackie** or the **managers**. The Manager dashboard (`/manager`) already consumes the same `active_employees` view, so simply by HR maintaining the roster in this dashboard, attendance auto-aligns.

### 5.2 PAB forgiveness (orphanage example)

> Already implemented — this is the existing flow that confirms why the unified roster matters. See [`implementation-plan-orphanage-visit-pab.md`](./implementation-plan-orphanage-visit-pab.md) and [`orphanage-dispute-flow.md`](./orphanage-dispute-flow.md).

- Insufficient Hubstaff hours (e.g. < 7h) → marked absent.
- If the absence is excused (orphanage visit), Allison and Ellie hand a name list to Accounting for **forgiveness**.
- Employee can file a dispute against a specific date.
- Accounting can approve "orphanage disputes," which forgives the absence and keeps the employee PAB-eligible against the 30-day rule.

This dashboard is **not** changing that flow — it just guarantees every employee in the dispute system actually exists in the master list, with the right department / rate.

### 5.3 Orphanage Budget on payroll

The Payroll Dashboard already has a section dedicated to orphanage payouts. No HR-side change required; the HR roster is what feeds names into that calculation.

---

## 6. Simple Wall (S-Wall) — already built

A company-wide social feed for policies and event updates is **already live** — see `src/components/swall/SWall.tsx` and the `S-Wall` tabs surfaced in every role app.

Posting permissions match the discussion: **managers, admin, CEO, Orphanage, HR, Accounting** can post. Employees can read, comment, and react. The HR dashboard already exposes the S-Wall tab with `canPost` enabled — see `src/components/hr/HrApp.tsx` (`HrSwallTab`).

---

## 7. What's Already Done (Phase 0)

These shipped while drafting this plan and unblock the rest of Phase 1:

1. **HR view added to RBAC** — `'hr'` is now a first-class `AppView`. Granted to anyone with `admin` or `hr_coordinator`. (`src/lib/rbac/views.ts`)
2. **`/hr` route + dashboard shell** — emerald/teal theming distinct from Manager (blue), CEO (yellow), Orphanage (pink), Admin (orange). (`app/hr/page.tsx`, `src/components/hr/HrApp.tsx`, `src/components/hr/HrSidebar.tsx`)
3. **View Switcher entry** — HR appears in the in-sidebar view switcher for any user with the role. (`src/components/rbac/ViewSwitcher.tsx`)
4. **Onboarding / Offboarding placeholder tabs** — visual scaffolding ready to receive real components.
5. **Profile-photo unification across all role views** — whatever picture an employee sets on the Employee Profile page now appears in the user-card on Admin / CEO / HR / Manager / Accounting / Orphanage sidebars. Same precedence everywhere: Google SSO photo (gated by session-email match) → Supabase upload → initials. (`src/hooks/useViewerProfilePhoto.ts`)

---

## 8. Phase Plan

### Phase 1 — Onboarding MVP (target: HR roster becomes authoritative)

1. **Roster table** on the HR dashboard backed by `active_employees` (re-uses the same view every other dashboard reads).
2. **"Add person" single-entry form** with department drop-down → rate pre-fill, custom-rate override.
3. **Draft / pending-work-email status** with a quick "Set work email" action.
4. **Schema additions** to `global_master_list`: `phone`, `location`, `source`, `job_description`, `status` (active / pending_work_email / off_boarded), `off_boarded_at`, `off_boarded_reason`. (Migration file in `references/`, dated.)
5. **Audit logging** on every create / edit / off-board (re-use the existing `audit_log` pattern — see `src/components/audit/AuditLogPanel.tsx`).

### Phase 2 — Bulk entry + Offboarding trigger

1. **CSV import flow** for the New Hire Checklist sheet → staged review → bulk commit. (Re-use the import infrastructure from [`csv-imports.md`](./csv-imports.md).)
2. **Search + Off Board** action with reason picker, wired to Drew's automation (webhook contract TBD).
3. **Off-boarded view filter** on the HR roster + retained-row badge.

### Phase 3 — Reporting & polish

1. **Attrition / reason-mix report** built from off-board fields.
2. **Optional confirmation toast** when Drew's automation reports completion.
3. **Tabular bulk-entry mode** if the single-form workflow proves too slow at 75/week.

---

## 9. Open Questions / Follow-ups

- **Webhook contract with Drew's automation** — what event payload does it expect (employee id, work email, personal email, off-board date, reason)? What does it return on success / failure?
- **Rate source authority** — is it `employee_hourly_rates` rows or the synced Google Sheet? (Both exist today — confirm which is canonical for new hires when the dashboard pre-fills.)
- **Department list** — pulled from existing distinct values in `global_master_list` / rates, or a new `departments` table? Phase 1 can start with distinct values; Phase 2 may need a managed list.
- **Permissioning detail** — do we want `hr_coordinator` to see Accounting *and* HR (today's behavior) or move them HR-only? Currently they retain both for backward compat.
- **Off-board reason taxonomy** — the discussion listed examples (`resigned`, `performance`, `time_manipulation`); confirm full list with Teal before locking the enum.

---

## 10. Risks

- **Schema churn on `global_master_list`** — every consumer reads it. Migrations need to refresh the `active_employees` view (precedent: 2026-04-22 upload-archive migration, 2026-05-02 address columns).
- **Bulk Monday entry slowness** — if Phase 1's single-form approach can't keep up with 75 rows in a sitting, Phase 2's CSV import becomes blocking.
- **Drew's automation coupling** — until the webhook contract is locked, "Off Board" is a manual hand-off. Plan for a fallback "mark off-boarded without firing automation" toggle for that interim window.
