# Plan — Admin → Diagnostics: Payroll Cycle Performance + HR Pipeline tabs

2026-09-04. Approved brief (Q1–Q5 answered by Kane). Two additions mid-build:
**KPI cards on each tab**, and **HR kept separate from Accounting** — two distinct tabs, two
distinct KPI rows, never one blended scoreboard. Plus: **smooth UI** — skeletons that do not
repaint, no layout shift on tab switch, no spinner flash on the 30s poll.

Kane's ask: *"calculate the percentage of successful payroll cycle — if there are 1,000
employees to be paid and only 300 was paid, we should know the performance each month to see
its success rate. Make one for HR pipeline as well."*

## Decisions taken

- **Q1 — declared-only, from when close-outs began.** The series starts at the first filed
  close-out (2026-08-10). Nothing before it is inferred, back-filled, or estimated.
  `payment_dispatches` is NOT read as a rate source — dropped from the build entirely.
- **Q2 — a closed cycle's record IS the final number.** One rate per cycle, the declared one.
  No second "wider" rate. `records_outstanding` stays a raw audit count, never a percentage.
- **Q3 — HR headline = promoted / staged.** The funnel beneath it is
  listed → staged → submitted → attended → promoted.
- **Q4 — month grain = calendar month of `period_end`** (the month the work was done),
  not `closed_at` (Aug 2–8 was closed Aug 14).
- **Q5 — admin-only**, inheriting the existing Diagnostics gate. No new feature key.

## Tasks

- [ ] 1. `src/lib/admin/cycle-performance.ts` + `.test.ts` — pure. Close-out summaries →
      per-cycle rows (`payable`, `paid`, `unpaid`, `rate`) + per-month rollups. No I/O.
- [ ] 2. `src/lib/admin/hr-pipeline-performance.ts` + `.test.ts` — pure. Checklist week counts
      + pending rows → per-week funnel + per-month rollups. Imports `pickChecklistWeek` /
      `normEmail` / `weekKeyFromIso` from `manager/orientation-weekly` — never re-derives them.
- [ ] 3. `src/lib/supabase/hr-new-hire-checklist.ts` — ADD `listChecklistWeekCounts()` (paged,
      additive, touches no existing function).
- [ ] 4. `app/api/admin/diagnostics/cycle-performance/route.ts` — same `requireAdmin()` as
      the diagnostics route. Reads `listCycleCloseouts()` only.
- [ ] 5. `app/api/admin/diagnostics/hr-pipeline/route.ts` — same gate. Reads
      `listOrientationHistory()` + `listChecklistWeeksByEmail()` + `listChecklistWeekCounts()`.
- [ ] 6. `src/components/admin/PayrollCyclePerformance.tsx` — KPI row + month cards + cycle table.
- [ ] 7. `src/components/admin/HrPipelinePerformance.tsx` — KPI row + funnel + week table.
- [ ] 8. `src/components/SystemDiagnostics.tsx` — tab strip only. The map is untouched.
- [ ] 9. Docs: `docs/features/diagnostics-performance-tabs.md`, INDEX row, memory +
      MEMORY.md pointer. Typecheck. One commit.

## The rules this surface carries

1. **A cycle with no close-out record has NO success rate.** It renders "Not closed" and is
   excluded from every denominator. Never 0%, never inferred. This is the
   `orientation-week-stats.ts` `measurable:false` rule (Kane 2026-08-26) applied to payroll.
2. **`disbursement_records` may never produce a rate.** Measured on live data 2026-09-04:
   2026-06-21 / 06-28 / 07-05 are 100% `pending` across 2,916 rows for weeks that were paid;
   Mar–May 2026 carry `status='paid'` with `paid_at` NULL; 2026-08-02 and 08-23 have no rows at
   all. A rate over that table reports three fully-paid weeks as 0%. It is read only as the
   `records_outstanding` cross-check already stored in the record, shown as a raw count.
3. **The Excluded tab is never counted as unpaid** — inherited from `cycle-closeout.md`. The
   declared rate is therefore ~98%, not a failure-hunting number, and that is correct.
4. **`unpaid.truncated` is added to the unpaid count**, never dropped — a silent truncation
   reads as "that's everyone".
5. **listed ≠ staged, and the HR rate is over STAGED** — inherited from
   `orientation-week-stats.ts`. `listed` is shown as its own column, never as a denominator.
6. **Every read is `selectAllPaged`.** Live row counts: checklist 1,479 · pending 1,049 ·
   app_settings close-out scan grows one row per week forever.
7. **No PII in either payload.** Counts, rates and dates only — the `system-diagnostics.md`
   security rule governs this route family.
8. **Staged counts decay** — `hr_pending_employees` rows are removed by scheduled deletion, so
   an old week's staged number shrinks over time. Both tabs stamp their read time and say so.
