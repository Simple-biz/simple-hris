# Score the upcoming pay week ahead of its Hubstaff file — Manager KPI Calculator + QC

**Date:** 2026-09-10 · **Approved:** Kane, same day ("SO BUILD It"), after the revised brief.
Rulings: **Q1** managers CAN lock and submit the upcoming week; bonuses sync when the file lands
(already true — rows are keyed `(department, period_start)` and the wizard joins on
`period_start === hubstaffWeekStart`, PayrollWizard.tsx:2948); Accounting is notified on publish ·
**Q2** QC officers get the upcoming week too · **Q3** exactly ONE week ahead (live Sunday + 7) ·
**Q4** HSL calculator out (own resolver) · **Q5** a USD-currency bonus scored ahead banks today's
FX — Lead Gen is PHP; noted, not changed.

Decisions stated in the brief and not contradicted: the Accounting notification fires on
**publish** (Mark Ready / Lock), for every week; recipients = active `accounting` role holders
(the `payroll.hours_gap` query); employees keep `kpi.scored` on publish per the amount-diff ruling.

Why the picker was the only obstacle: `weekResolvedFromUploads` flips true once the LIVE batch
resolves (DeptBonusCalculator.tsx:1996) and never depends on the week SELECTED afterwards. The
gate exists to stop the Monday-anchored clock seed being written; a Sunday-anchored `live + 7`
passes `loadDept`, `kpiAutosaveGate` and `saveDept` unchanged. Nothing loosens.

Precedents: the picker's own synthetic entries (`weekOptions`, :916-925); `notifyZeroHoursGap` +
its ALTER + apply script for the accounting-only notification.

## Tasks

- [x] Plan doc (this file)
- [x] 1. `references/sql/alter/2026-09-10_add_kpi_published_notification_type.sql` — restate the
      FULL allowed set from the newest ALTER + `kpi.published`.
- [x] 2. `scripts/apply-kpi-published-notification-type.mjs` — copy of the hours-gap script; reads
      the LIVE constraint and aborts if it carries a type our list lacks; `--verify` mode.
- [x] 3. `scripts/audit-pending-migrations.mts` — `probeNotificationType(…, 'kpi.published')`.
- [x] 4. `src/lib/hubstaff/use-pay-weeks.ts` — pure `nextPayWeek(currentWeekStart)` (Sunday + 7)
      + `use-pay-weeks.test.ts`; `usePayWeeks` returns `upcomingWeek`; fix the docstring that
      says the start is "Monday-anchored" (it is the file's Sunday).
- [x] 5. `src/lib/notifications/kpi-published.ts` + test — `notifyKpiPublished`: accounting role
      holders, de-dupe per (recipient, department, period_start, status), failures through
      `recordNotifyFailure`.
- [x] 6. `src/lib/notifications/notification-views.ts` — `'kpi.published': ['accounting']`.
- [x] 7. `app/api/hsl-bonus/period-status/route.ts` — fire it beside `notifyKpiScored` on
      ready/locked, best-effort.
- [x] 8. `DeptBonusCalculator.tsx` — `weekOptions` adds the upcoming week while no file exists;
      WeekPicker + header show "upcoming · no Hubstaff yet", never "past".
- [x] 9. `QCApp.tsx` — period selector includes `upcomingWeek`.
- [x] 10. `tsc --noEmit` + `npm test` (dev server live — no `next build`).
- [x] 11. Docs: `hsl-kpi-calculator-2026-07.md` §Scoring the upcoming week; `notification-alerts.md`
      mount table; INDEX row 25 invariant + wikilink; memory `kpi-calculator-score-ahead` +
      MEMORY.md pointer; Deploy notes **PENDING** until the ALTER runs. One commit.

## Invariants this must not break

- The upcoming week is derived ONLY from `currentWeekStart` (a file's Sunday) + 7 — never from
  the clock. A Monday-anchored key is invisible to every reader forever (`audit-kpi-key-drift.mts`).
- The option is labelled by DATES; "next week" is relative to the live batch, not today.
- `presumedWeek` in the tab cache is written only by the resolver (live week) — never the
  synthetic week.
- `weekResolved` / `kpiAutosaveGate` / `saveDept` untouched.
- The ALTER restates the FULL type list; the apply script diffs the live constraint first.
- The notifier never `console.warn`s a failure — `recordNotifyFailure`, so a missed DDL is visible.
- `kpi.scored`'s amount-diff rule is untouched.
