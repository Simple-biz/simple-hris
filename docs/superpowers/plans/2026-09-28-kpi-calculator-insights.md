# Manager → KPI Calculator → Departments: insight cards

Brief: posted 2026-09-28 (blueprint, no NEEDS). Three cards above the department grid on the
manager landing: a rotating **department spotlight** (average bonus per week), a **top earner**
spotlight for the selected week, and a wider **trend line** of the total sent to Accounting each
week. Read-only. No migration.

## Decisions (the brief's CHOSEN lines)

1. **Sent to Accounting = a dept-week whose `hsl_bonus_period_status.status` is `ready` or `locked`.**
   That is the transition that fires `kpi.published` to Accounting
   (`app/api/hsl-bonus/period-status/route.ts:95-100`) and the state the Wizard pays.
2. **Department average = the dept's sent total ÷ the weeks it sent** in the 12-week window, with
   ₱/person as the secondary figure. The card rotates one department at a time.
3. **Top earner follows the week picker** and reads every SAVED row for that week, drafts included,
   labelled Sent / Projected. A person in two departments is summed. Ties → random pick, re-rollable.
4. **Trend = the last 12 Sunday weeks, oldest left.** A week with no saved rows has no point (the
   line breaks). A week with rows but nothing sent is a real ₱0. Monotone cubic, never Catmull-Rom.
5. **Scope = the grid's departments, re-checked server-side** against the My Team gate
   (`src/lib/manager/managed-department-gate.ts:34-53`). Manager landing only (`showInsights`).

## Tasks

### Task 1 — pure module `src/lib/manager/kpi-insights.ts`
- [x] `scopeInsightDeptKeys(requested, managed, elevatedUnassigned)` — intersect with assignments
- [x] `trendWindow(throughSunday, weeks)` — Sunday list, oldest first
- [x] `buildKpiInsights({ weeks, selectedWeek, applied, statuses })` — per-week sent/pending, per-dept
      averages, the selected week's top earners (ties kept together)
- [x] `monotonePath(points)` — Steffen (d3 monotoneX tangents), no overshoot; `niceTicks`, `compactPeso`
- [x] tests in `kpi-insights.test.ts` (node:test)

### Task 2 — reads `src/lib/supabase/kpi-insights-db.ts`
- [x] status rows for the scoped depts over the window weeks + the picked week, paged; the window ends at the newest SENT week (`.limit(1)` probe)
- [x] applied rows per week, one `selectAllPaged` each, in parallel, ordered by `id`,
      projection `department, period_start, employee_email, employee_name, amount`

### Task 3 — route `app/api/manager/kpi-insights/route.ts`
- [x] role gate + My Team scope, identical to `department-members`
- [x] `?depts=a,b&week=YYYY-MM-DD`; a malformed week → 400; out-of-scope keys dropped
- [x] source-scan test pins the gate and the paging

### Task 4 — UI `src/components/manager/KpiInsightCards.tsx`
- [x] `DeptSpotlightCard` — auto-rotate 5 s, pause on hover/focus, dots, reduced-motion = manual only
- [x] `TopEarnerCard` — initials avatar, amount, Sent/Projected, tie count + shuffle
- [x] `KpiSentTrendChart` — SVG, path draw-in, staggered markers, `d` morph, spring crosshair,
      keyboard focus = hover, sr-only table twin
- [x] held-previous-render at reduced opacity on refetch (no skeleton flash)

### Task 5 — wire-up
- [x] `KPI_CACHE_KEYS.insights(surface, week, depts)` — paint only
- [x] `DeptBonusCalculator` renders the cards when `showInsights && !isQc`; refresh token bumps on
      manual refresh and live refresh
- [x] `ManagerApp` passes `showInsights`

### Task 6 — verify + document
- [x] `scripts/verify-kpi-insights.ts` read-only (a `.mts` entry cannot import `department-bonus` named exports under tsx) against PROD, prints the trend as text
- [x] typecheck, the new tests, the cache tests
- [x] feature doc, INDEX row, memory entry, one commit by explicit path
