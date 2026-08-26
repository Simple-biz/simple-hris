# HR → New Hire Checklist → Orientation (week-scoped attendance)

Approved brief 2026-08-26. Two deliverables in one commit:

1. A new **Orientation** inner tab inside HR's New Hire Checklist, scoped to that tab's
   existing week selector, with KPI cards, a per-department breakdown, the people behind
   each number, and load-once caching.
2. A **motion pass** on the already-shipped Manager → My Team → Orientation panel
   (render-only — no counts, no reads, no gates change).

## Kane's rulings

- **Q1 denominator** — the rate is `attended / staged`, exactly the manager tally's
  denominator. "Listed" (HR checklist rows) and "Not staged" are their own cards so the
  intake gap is visible instead of quietly deflating the rate.
- **Q2 unmarked** — *"only produce data when it has been passed to the managers and the
  managers have marked it; if it hasn't been marked then just put a note on it."*
  → a week with **zero** staged hires renders a **note**, never a 0% rate. A week that has
  data but contains hires no manager ever marked renders a note naming that count. The
  denominator stays `attended / total` so HR and the manager tally can never disagree
  (`docs/features/manager-orientation-attendance.md` — the rate is the one number both
  surfaces publish).
- **Q3 export** — the tab already exports (grid Excel, this week / all weeks). No new
  export path.

## What the probes measured (read-only, prod, 2026-08-26)

| Fact | Number |
|---|---|
| `hr_new_hire_checklist` rows | **1,351 — past the 1000-row cap** |
| `hr_pending_employees` rows | 976 (935 attended · 41 not: 38 no-show, 3 awaiting) |
| Listed vs staged, 2026-08-23 | 79 listed → 70 staged → 66 attended |
| Listed vs staged, 2026-08-16 | 60 → 56 → 50 |
| Listed vs staged, 2026-08-02 | 102 → 89 → 83 |
| Weeks with checklist rows but ~0 staged | every week before 2026-06-07 (2026-05-03: 52 listed, 0 staged) |
| Non-Lead-Gen staged hires, all weeks | **14, and all 14 attended** |

The listed→staged gap (~9/week) is why the rate cannot run over "listed": those people
carry no `hr_pending_employees` row at all, so they can never hold an attended stamp and
the rate would never reach 100%. The pre-June weeks are why a 0% must never render.

The Lead-Gen question died on measurement: `rateAll == rateLG` in all 12 weeks, so there is
**no** Lead Gen split, no second rate, no filter — despite the invite itself being Lead Gen
only (`docs/features/new-hire-checklist.md`).

## Tasks

- [x] 1. `src/lib/hr/orientation-week-stats.ts` — pure. Takes the week's checklist rows +
      the week's `OrientationWeek` (from the shared model) → KPIs, `notStaged[]`,
      per-department rows, and the `measurable` flag that drives the note.
- [x] 2. `src/lib/hr/orientation-week-stats.test.ts` — `node:test`. Covers the two live
      oddballs (id 717 both stamps → attended; id 1034 reverted no-show → awaiting), the
      unmeasurable week, the listed→staged gap, and rate parity with `attendanceRate`.
- [x] 3. `src/lib/hr/tab-cache.ts` — add `orientationAttendance` key.
- [x] 4. `app/api/hr/orientation-attendance/route.ts` —
      `requireFeatureAccess("hr", "new_hire_checklist", "view")`; `listOrientationHistory()`
      company-wide + `listChecklistWeeksByEmail()`, both already `selectAllPaged`; rates
      stripped unconditionally; a checklist failure is surfaced, never degraded.
- [x] 5. `src/hooks/useHrOrientationAttendance.ts` — cache-seeded, skips the mount fetch
      when warm, manual refresh writes back through the cache.
- [x] 6. `src/components/hr/HrOrientationAttendancePanel.tsx` — the tab body.
- [x] 7. `src/components/hr/HrNewHireChecklist.tsx` — inner tab bar; shares `period` and
      passes the week's grid rows down. Grid, mutations, lock, export untouched.
- [x] 8. `src/components/manager/OrientationAttendancePanel.tsx` — motion only.
- [x] 9. Docs: `docs/features/hr-orientation-attendance.md`, INDEX row, memory +
      `MEMORY.md` pointer, cross-link from `manager-orientation-attendance.md`.
- [x] 10. `npx tsc --noEmit` + the new test. Check for a live `next dev` before any build.

No migration. No DDL, webhook, cron, or env var.
