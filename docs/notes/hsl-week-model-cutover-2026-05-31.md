# HSL PAB week cutover: Mon→Sun → Sun→Sat (effective 2026-05-31)

**Status:** live.
**Date:** 2026-07-14. **Swept app-wide 2026-08-27** (see "The 2026-08-27 sweep" below).
**Scope:** authoritative pay/dispatch engine (`current-pay.ts`), Accounting's Payroll Wizard
(pay mirror, PAB eligibility, and the PAB Calendar display), `member-monthly-pay.ts`, and
every PAB calendar surface in the app.

## What changed

HSL's (Hogan) work/PAB week moved from **Mon→Sun** to **Sun→Sat**. This is an
**effective-date cutover**, not a global flip:

- Weeks/PAB months anchored **before** 2026-05-31 keep computing **Mon→Sun** — May 2026 and
  earlier stay byte-identical to what was produced before (and to the frozen
  `hsl_week_model_snapshot` mon_sun baseline). May's last week uploads on 2026-05-24.
- Weeks/PAB months anchored **on/after** 2026-05-31 compute **Sun→Sat** — **June 2026 onward**.

Only **HSL** employees are affected. Every other department was already Sun→Sat.

> **History:** the cutover was first wired at 2026-07-05 (July onward). It was then moved back to
> **2026-05-31** to include the **June 2026** period as Sun→Sat as well. This is a deliberate
> RETROACTIVE change to June — June HSL pay/PAB that may have already been computed/dispatched as
> Mon→Sun will now recompute as Sun→Sat. Verify June against dispatch / the mon_sun snapshot and
> re-run the June cycle if the numbers moved.

## Why 2026-05-31 (a Sunday), not June 1

The server resolves the model **per-upload** from the Hubstaff file's **Sunday start date**; the
wizard resolves it **per-PAB-month** from the month's first Monday. June's first Sun→Sat week
(May 31 – Jun 6, owned by Monday Jun 1) comes from the `2026-05-31_to_…` upload. Anchoring the
cutover on that Sunday (2026-05-31) makes both resolutions agree: the June-owning upload
(start May 31) and June's PAB-month Monday (Jun 1) both land on/after the cutover → Sun→Sat, while
May's last-week upload (start May 24) stays Mon→Sun. A June-1 cutover would have flipped the wizard
but left the pay engine paying June's first week Mon→Sun.

## How it resolves

- **Cutover date** lives in `app_settings['hsl.week_model_cutover']` (YYYY-MM-DD). When unset, the
  code falls back to `HSL_WEEK_MODEL_DEFAULT_CUTOVER = '2026-05-31'`
  ([hsl-week-model.ts](../../src/lib/payroll/hsl-week-model.ts)), so the cutover is live without a
  DB write. A stored value overrides the default (move/disable the cutover from data, no deploy).
- Both call sites resolve via `resolveHslWeekModelWithDefault(anchor, settingValue)`:
  - **Server** ([current-pay.ts](../../src/lib/payroll/current-pay.ts)) anchors on the upload's
    **file start date** (per-upload).
  - **Wizard** ([PayrollWizard.tsx](../../src/components/PayrollWizard.tsx)) anchors on the viewed
    **PAB-month start** for eligibility/calendar; `payDaysByEmail` anchors on the upload start.

## Invariants / guardrails

1. **PAB-month ownership + Tech-bonus timing stay MONDAY-based** for all week models. A Sun→Sat HSL
   week is owned by the month of the Monday inside it. In `current-pay.ts`, `weekMonday` is derived
   from the `mon_sun` variant regardless of the active model, so switching the pay window to
   Sun→Sat never moves a week into a different payroll cycle.
2. **Only the week anchor + period-end snap move.** The HSL ≥5-of-7 quota, weekend credit and
   overnight forward/backward pairing are identical in both models.
3. **Anchor from a stable date** — the upload/file start or PAB-month start — never a week-shape
   dependent value.
4. The pure `resolveHslWeekModel` and its tests are unchanged; the default lives in the wrapper
   `resolveHslWeekModelWithDefault`.

## The 2026-08-27 sweep (Aliviah's ticket)

> *"All PAB calendars need to be set to Sunday-Saturday. Some HSL still come up as
> Monday-Sunday."*

The cutover was correct and live — `app_settings['hsl.week_model_cutover']` is **unset**, so
the `2026-05-31` code default applies and every month from June 2026 on resolves `sun_sat`.
The bug was **reach**: only four call sites ever resolved the model. Five others took a
default and stayed on the pre-cutover week for three months.

**Root cause — two helpers with a legacy default.** `checkHslPabEligibility(…, weekModel =
'mon_sun')` and `getHslAdjustedEnd(…, weekModel = 'mon_sun')` let a caller inherit the
pre-cutover week by simply not passing an argument. `buildCalendarMonthWeeksIncludingWeekends`
had the same shape (`startOnSunday = false`, commented "Default false = Mon–Sun (HSL)" —
written before the cutover and inverted by it). **All three parameters are now REQUIRED.**
There is no safe default for a value whose correct answer changes on a date.

| Surface | Was | Now |
|---|---|---|
| `member-monthly-pay.ts` | **scored HSL PAB Mon→Sun** while dispatch paid Sun→Sat | resolves the cutover, anchored on the PAB-month start |
| `ManagerMemberHoursMini` | Mon–Sun grid, `M T W T F S S` | resolved model; Sun–Sat for current months |
| `EmployeeMyHours` | Mon–Sun grid; eligibility walked Mon–Fri with no 5-of-7 | resolved model; HSL now goes through `checkHslPabEligibility` |
| `EmployeeDashboard` | Mon–Fri 5-column, **no HSL branch at all** | 7-column; HSL full-week, non-HSL Sun–Sat display |
| `CreateOrphanageStyleDisputeDialog` | hardcoded `buildPabCalendarWeeksMonSun` | `buildPabCalendarWeeksFullWeek(…, model)` |

`member-monthly-pay.ts` was the serious one: it backs `/api/manager/member-monthly-pay`, so
the PAB verdict shown to employees and managers was computed on a different week than the one
dispatch paid on.

**Non-HSL calendars (Kane's ruling).** "All calendars" was taken to mean the **grid**, not the
**money**. Non-HSL PAB is still won or lost on **Mon–Fri**; the grids now render Sun–Sat with
Saturday and Sunday as `scoring: false` display cells. `PabCalendarDay.scoring` marks them, and
**every verdict must filter on it** — a consumer that flattens a display grid and runs
`.every(d => d.passes)` fails every employee on two blank cells. This preserves Invariant 1
above. Pinned by `src/lib/hubstaff/pab-calendar-sun-sat-display.test.ts`, whose load-bearing
assertion is an identity: the scoring cells of the Sun–Sat grid are *exactly* the cells the old
Mon–Fri builder produced, across the live overrides and the default ranges.

**Historical months are untouched.** Pre-cutover months still render Mon→Sun, so May 2026 and
earlier keep matching the frozen `hsl_week_model_snapshot` baseline and what was dispatched.

**Not fixed here (flagged, Kane's call):** `pab_period_overrides` only holds a Sun–Sat window
because Accounting hand-sets it each month (2026-08 = Sun Aug 2 → Sat Aug 29; 2026-07 was Mon
Jul 6 → Fri Jul 31). The **code default is still Mon→Fri** (`getPabMonthRange`), so a month
nobody sets — September 2026 defaults to Mon Sep 7 → Fri Oct 2 — reverts. Changing that default
would move the PAB window for every un-overridden month, so it was deliberately left alone.

## Verification

- Unit: `npx tsx --test src/lib/payroll/hsl-week-model.test.ts` (boundary tests assert May stays
  Mon→Sun, June flips to Sun→Sat, ownership Monday stays correct; a `@ts-expect-error` case pins
  that `weekModel` is required and cannot be silently inherited again).
- Unit: `npx tsx --test src/lib/hubstaff/pab-calendar-sun-sat-display.test.ts` (the non-HSL
  scoring-set identity + weekend cells never reading as a pass).
- Wizard: a **June 2026** HSL PAB Calendar now reads **Sun … Sat** with Sunday-start weeks and
  live weekend cells; a **May 2026** one still reads **Mon … Sun**.
