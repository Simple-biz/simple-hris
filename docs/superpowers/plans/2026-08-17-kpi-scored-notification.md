# KPI scored → employee live update + bonus toast

Approved 2026-08-17 (Q1 = full employee chime; Q2 = re-notify on amount change —
a disputed/re-ordered bonus must announce itself).

**Trigger rule:** notify only on a change the employee can SEE.
1. Dept-week status flips into `ready`/`locked` → notify everyone with a non-zero total.
2. A bonus write lands on an ALREADY visible week → notify only people whose total
   CHANGED vs their last `kpi.scored` notification (details.amount).
Draft weeks never notify (employees can't see drafts — `employee-kpi-results.ts:12-15`).
Autosave is inherently safe: identical totals diff to nothing.

## Tasks

- [ ] `references/sql/alter/2026-08-17_add_kpi_scored_notification_type.sql` — restate
      the FULL type CHECK (2026-08-03 list + `kpi.scored`); paired
      `scripts/apply-kpi-scored-notification-type.mjs` (pg over DATABASE_URL, `--verify`
      mode, superset guard: abort if the live CHECK contains a type our list lacks).
- [ ] `src/lib/notifications/kpi-scored.ts`
      - pure `sumKpiTotalsByEmail(appliedRows, hslEntries)` — per-raw-email totals
      - pure `planKpiScoredInserts({ totals, lastNotified, ... })` — decides who gets a
        row, first-time-zero skipped, unchanged skipped, changed gets previous_amount
      - `notifyKpiScored({ department, periodStart })` — status gate → fetch (paged) →
        reverse-alias to login (payroll-available.ts pattern) → diff → batched insert
      - `kpi-scored.test.ts` beside it (node:test)
- [ ] Wire (all best-effort try/catch — a notify failure never fails the save):
      - `app/api/hsl-bonus/period-status/route.ts` POST (after upsert, status visible)
      - `app/api/bonus-catalog-applied/route.ts` POST (after saveDeptPeriodApplied)
      - `app/api/hsl-bonus/entries/route.ts` POST (group entries by dept+period)
- [ ] `notification-views.ts`: `'kpi.scored': ['employee']`
- [ ] `NotificationsPanel.tsx`: Trophy icon for kpi.scored (positive card otherwise stock)
- [ ] `EmployeeApp.tsx`: `useNotificationChime(employeeEmail, { view: 'employee' })`
- [ ] `EmployeeKpiResults.tsx`: 30s visibility-aware poll (the postgres_changes sub is
      dead for anon+RLS; focus refetch stays)
- [ ] node:test run + `npx tsc --noEmit` (check for live dev server before any build)
- [ ] `docs/features/kpi-scored-notification.md` + INDEX row + memory + MEMORY.md line
- [ ] One commit, explicit paths only

## Out of scope
entries/dept-week DELETE paths (doc'd), EmployeeDashboard home KPI card refresh policy,
manager UI, bonus math, Team-tab rankings, HR/Accounting chime scoping.
