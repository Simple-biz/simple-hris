# PAB period + forgiveness parity across surfaces

**Status:** fixed.
**Date:** 2026-06-12.
**Scope:** Employee My Hours, Employee Dashboard, system Overview, PayrollWizard PAB period
settings, and the server pay calculator (`member-monthly-pay.ts`). Authoritative dispatch
(`current-pay.ts` / `dispatch-bonuses.ts`) was already correct and is the reference behavior
every other surface was aligned to.

## TL;DR

The Perfect Attendance Bonus (PAB) is computed authoritatively at **dispatch**
(`current-pay.ts` → `dispatch-bonuses.ts`). Several *estimate / display* surfaces diverged from
it, producing wrong PAB on the employee-facing screens. Five distinct bugs were fixed so every
surface mirrors dispatch:

1. Forgiveness ignored in the employee pay summary.
2. My Hours ignored the wizard's custom PAB period.
3. Custom periods didn't "stick" when resolving a PAB month from a CSV/date.
4. A PAB month override could be saved/shown for an entirely different month.
5. The final-PAB-week was mis-attributed for Sunday-start uploads.

---

## 1. Forgiveness parity in `member-monthly-pay.ts`

**Symptom:** an employee who qualified for May PAB (paid at dispatch) saw `₱0 · not yet` in
**My Hours**, even though the month was done.

**Cause:** `computeMemberMonthlyPay` (backs `/api/manager/member-monthly-pay`, consumed by My
Hours + the manager My Team modal) computed PAB eligibility from **raw Hubstaff hours only**. It
applied US-holiday forgiveness but never loaded approved PAB disputes / time adjustments — so a
forgiven sub-7h weekday (orphanage visit, approved dispute, accounting time correction) read as a
miss. Dispatch applies these via `applyPabAdjustments` (≥4h effective → forces 7h).

**Fix:**
- Exported `applyPabAdjustments` from `dispatch-bonuses.ts` (shared, single implementation).
- Added `fetchForgivenDatesForEmails()` in `member-monthly-pay.ts` — approved
  `pab_day_disputes` (`approved` / `accounting_approved`) + approved `time_adjustment_requests`,
  flattened across the alias set into one `ISO date → override_hours|null` map.
- Eligibility now runs against `eligibilityHours = applyPabAdjustments(hoursByDateKey,
  forgivenDates, holidaySet)` for both HSL and non-HSL. **Paid hours are untouched** — forgiveness
  only affects eligibility, never adds payable time.

## 2. My Hours honors the wizard's PAB period

**Symptom:** the wizard's PAB Calendar period setter (`pab_period_overrides`) wasn't reflected in
My Hours; eligibility was evaluated over the raw calendar month.

**Fix (`EmployeeMyHours.tsx`):**
- Reads `pab_period_overrides` in the same `/api/app-settings?keys=` batch as the holiday
  settings (`pabOverrides`).
- `pabRange` resolves the viewed month's window via `resolvePabRangeForMonth` (override or
  default), shown as a **"PAB period: … – … [custom]"** header line.
- `isPAEligible` walks every Mon–Fri in `pabRange` (not the calendar month), passing a day on
  ≥7h, a US holiday, an approved forgiving dispute, or (HSL) an overnight pairing.
- The authoritative PAB **amount** still comes from `payView.pab` (`member-monthly-pay`).

## 3. Override-window containment — custom month is "sticky"

**Symptom:** a custom override window that runs into the next month didn't claim its dates
everywhere; a CSV/date inside the window resolved to the wrong PAB month.

**Cause:** surfaces derived the PAB month from a date via the canonical Monday rule **first**, then
looked up the override by that (possibly wrong) month key.

**Fix:** three shared helpers in `pab-period-settings.ts`, used by every surface
(`EmployeeDashboard`, `EmployeeMyHours`, `EmployeePabCalendar`, `Overview`):
- `resolvePabMonthForDate(date, overrides)` — an override window **claims** every date inside it
  for its month key; falls back to `getCurrentPabMonth(date)`.
- `resolvePabMonthFromColumns(cols, overrides)` — latest parseable CSV date → the above.
- `resolvePabRangeForMonth(year, month, overrides)` — explicit window (override else
  `getPabMonthRange`), with an `isOverride` flag; authoritative for every department once set.

`Overview` previously ignored per-month overrides entirely (legacy manual range only) — now fixed.

## 4. Month-intersection guard (period ≠ calendar month, but must intersect it)

**Symptom:** the **May** PAB month showed a window of **Jun 1 – Jul 3** — which is actually
**June's** default window (June 2026's last Monday is Jun 29 → Friday Jul 3).

**Key fact:** a PAB period is **not** the calendar month; it routinely spills into the next month.
But a window that lies **entirely** in a different month is invalid.

**Fix:**
- `saveActiveMonthOverride` (PayrollWizard) rejects a save whose window doesn't include ≥1 day of
  the selected month.
- `parsePabPeriodOverrides` **drops** any already-stored out-of-month entry on read, so the month
  falls back to its real default everywhere (wizard, My Hours, dashboard, overview).

**Root cause of the bad data** — see §5: the wizard's editor/highlight tracked the *file-pinned*
effective month, so editing while a file was loaded could write under the wrong month key. Fixed
with a modal-local `pabEditMonth` the selector drives directly (clicking a pill always moves the
highlight, date inputs, readout, and the save/auto-calc/reset target). The settings modal also
gained a plain-language **period readout** and per-pill tooltips showing each month's resolved
window.

## 5. Final-PAB-week attribution for Sunday-start uploads

**Symptom:** May's PAB "kicked in" on the **May 31 – Jun 6** week instead of **May 24 – 30**.

**Cause:** Hubstaff uploads start on **Sunday**. The week's *owning Monday* is `weekStart + 1`
(same for the non-HSL Sun–Sat week and the HSL Mon–Sun week, which drops the leading Sunday). The
PayrollWizard and EmployeeDashboard reimplemented this inline and walked **back** from the Sunday
(`weekStart − 6`), so the `…05-31_to_…06-06` file (Sun May 31) was attributed to Monday **May 25 →
May** and, since its end (Jun 6) ≥ May 29, flagged as **May's final PAB week**.

**Fix:** both now map a Sunday start forward (`+1`), matching `member-monthly-pay.ts →
weekMonForPab` and the authoritative `current-pay.ts` (which uses
`payWeekFromUploadStart(start, true).start`). They also run `weekPabRange` through
`resolvePabRangeForMonth` so overrides bound the final-week check. Result: May's PAB attaches to
the **May 24 – 30** paystub; `…05-31_to_…06-06` is June's week.

---

## Files touched

| File | Change |
|---|---|
| `src/lib/payroll/dispatch-bonuses.ts` | Exported `applyPabAdjustments`. |
| `src/lib/payroll/member-monthly-pay.ts` | Fetch + apply dispute/time-adjustment forgiveness in eligibility (§1). |
| `src/lib/pab-period-settings.ts` | `resolvePabMonthForDate` / `resolvePabMonthFromColumns` / `resolvePabRangeForMonth`; month-intersection drop in `parsePabPeriodOverrides` (§3, §4). |
| `src/components/employee/EmployeeMyHours.tsx` | PAB-period-aware `pabRange` + `isPAEligible`; header readout (§2). |
| `src/components/employee/EmployeeDashboard.tsx` | Override-aware month resolution; Sunday-start owning-Monday fix (§3, §5). |
| `src/components/employee/EmployeePabCalendar.tsx` | Override-aware month resolution (§3). |
| `src/components/Overview.tsx` | Honors per-month overrides; override-window-aware month resolution (§3). |
| `src/components/PayrollWizard.tsx` | `pabEditMonth` decoupling, period readout + tooltips, save guard, Sunday-start owning-Monday fix, override-aware `weekPabRange` (§4, §5). |

## Reference docs

- `docs/reference/business-logic.md` → "Perfect Attendance Bonus (PAB)", "PAB period
  configuration", "Weekly gating for monthly bonuses".
- Memory: `project_pab_forgiveness_parity.md`, `project_pab_period_schema.md`.

## Invariant for future work

Any surface that **computes or displays** PAB must mirror dispatch on all three axes:
1. **Forgiveness** — apply approved disputes + time adjustments (≥4h effective → 7h) + holidays.
2. **Period window** — honor `pab_period_overrides`; the period is not the calendar month but must
   intersect it.
3. **Week ownership** — the owning Monday of a Sunday-start upload is `weekStart + 1`; never walk
   back from a Sunday. Prefer `payWeekFromUploadStart(...).start`.
