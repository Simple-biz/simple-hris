# Hubstaff 8-day Sun→Sun exports: the "lost leading Sunday" problem

**Status:** known issue, mitigated per-week via additive backfill. Root-cause code fix still open.
**First diagnosed / fixed:** 2026-06-03 (week of May 10, 2026).

## Symptom

In the PAB calendar (and any surface fed by Hubstaff hours), **Sunday May 10, 2026 showed
no data for everyone**, even though 98 people actually worked that day (44 of them a full
≥7h day). Adjacent Sundays (May 3, 17, 24, 31) displayed fine.

## Root cause

`hubstaff_hours` stores each weekly upload as **7 fixed weekday columns** (`monday`…`sunday`),
not per-date columns. A row's calendar dates are reconstructed downstream from the
**source filename's date range** via
[`resolveCanonicalColumnsToIso`](../../src/lib/hubstaff/calendar-column-dedupe.ts) — it walks
every date in the range and assigns it to its weekday slot.

Starting the week of **May 10, 2026**, the Hubstaff exports changed shape:

| Weeks | Filename span | Days | Sundays in range |
|---|---|---|---|
| … through `2026-05-03_to_2026-05-09` | Sun → Sat | 7 | one |
| `2026-05-10_to_2026-05-17` onward | **Sun → Sun** | **8** | **two** |

An 8-day Sun→Sun file contains **two Sundays** but there is only **one `sunday` column**.
Both the importer (`resolveColumnMapping` in
[`hubstaff-hours-db.ts`](../../src/lib/supabase/hubstaff-hours-db.ts)) and the date resolver
use **last-Sunday-wins**, so:

- `2026-05-10_to_2026-05-17` → `sunday` holds **May 17**'s hours, resolves to **May 17**.
- `2026-05-17_to_2026-05-24` → `sunday` = **May 24**.
- `2026-05-24_to_2026-05-31` → `sunday` = **May 31**.

Every week's stored Sunday is actually the **following** week's opening Sunday. The files
**overlap** (May 17 lives in both the 05-10 and 05-17 files, etc.). Because the prior 7-day
file (`05-03_to_05-09`) ends on Saturday May 9, the very **first leading Sunday (May 10)
has no file that resolves to it** → it is dropped everywhere (calendar, PAB eligibility, pay).

This is a see-saw: with 7 slots and N+1 distinct Sundays across overlapping files, exactly one
Sunday always falls off. Last-Sunday-wins drops the **first** one (May 10); naive
first-Sunday-wins would instead drop the **last** one (May 31, still needed by May's final week).

## Why the obvious fixes don't work

- **Overwrite the 05-10 week's `sunday` with May 10's value** — the resolver still maps that
  column to **May 17** (from the filename range), so May 10 stays blank *and* May 17 is
  corrupted. Actively harmful.
- **Rename the 05-10 file to a 7-day `…05-10_to_05-16` span** — makes `sunday` resolve to
  May 10, but May 17 (which is sourced *only* from this file) goes blank, cascading into
  May 24 → May 31. Requires re-keying the whole chain.

## Solution applied (additive, non-destructive)

Add a **separate, complete, backdated Mon→Sun week** as a NON-current upload, so the calendar
merges May 10 in by real date without touching any existing week:

- `source_file = backfill-may10_2026-05-04_to_2026-05-10.csv` (range resolves `sunday` → **May 10**)
- `sunday` = each person's May 10 hours (from the CSV's first column)
- `monday`…`saturday` = May 04–09, **copied verbatim** from the existing `05-03` week, so
  merge-order collisions are value-identical and can't corrupt those days
- `uploaded_at` backdated to `2026-05-11` and `is_current = false`, so it never becomes
  `files[0]` (the payroll source of truth — see [PayrollWizard.tsx:1491](../../src/components/PayrollWizard.tsx))
  and never displaces the active week

Script: [`scripts/backfill-may10-additive.mjs`](../../scripts/backfill-may10-additive.mjs)
(dry-run by default; `--commit` to write). Affected-people list:
[`references/may10_affected.csv`](../../references/may10_affected.csv) — 98 people, 44 full-day.

### Verification

- New file resolves `sunday` → `2026-05-10`; Edward Maverick Tahil shows 8:15:27 on May 10.
- `files[0]` / `is_current` still `2026-05-24_to_2026-05-31` — payroll untouched.
- May 11–17 (incl. the May 17 cell) byte-for-byte unchanged.

## Open follow-ups

1. **Same issue affects every 8-day file going forward** — each new Sun→Sun upload's leading
   Sunday is dropped. Either keep applying the additive backfill per week, or fix the root cause.
2. **Root-cause options:** (a) make the importer/resolver split 8-day files into
   non-overlapping 7-day weeks; or (b) store actual ISO-date columns instead of fixed weekday
   columns so two Sundays can coexist.
3. **Retro check:** cross-reference the 44 full-day people against already-decided May PAB
   eligibility — some may have been marked short for the week of May 10 and could now pass.

## Update 2026-06-10 — Payroll Wizard now resolves this correctly for pay

Two changes to the **Initial Calculation** pay path largely resolve follow-up #1 *for payroll
totals* (the additive backfill is still the fix for the **calendar/PAB display** of a dropped
leading Sunday):

1. **Resolve canonical columns to TRUE file dates, then window** — not onto the dept pay week.
   `payDaysByEmail` (in [PayrollWizard.tsx](../../src/components/PayrollWizard.tsx)) and
   `current-pay.ts` previously used `resolveCanonicalColumnsToPayWeek`, which forced the lone
   `sunday` slot (= the file's **trailing** Sunday after last-wins) onto whatever Sunday sat in
   the department window. For non-HSL (Sun→Sat) that **paid the trailing Sunday's hours** under
   the leading Sunday's date. Now both use `resolveCanonicalColumnsToIso(row, sourceFile)` (true
   dates) and let the pay-week window drop the out-of-week Sunday. See
   [payroll-wizard-final-pay.md](../features/payroll-wizard-final-pay.md).

2. **`payDaysByEmail` reads the cross-upload merged rows** (`hubstaffRowsForPab`), not the single
   current file. The boundary Sunday is recovered from the **adjacent upload** where that date is
   the trailing day — e.g. the non-HSL week **May 31–Jun 6** gets May 31's hours from the
   `2026-05-24_to_2026-05-31` upload, while the current `2026-05-31_to_2026-06-07` upload supplies
   Jun 1–6 and its `sunday` (= Jun 7) is correctly windowed out.

**Validated** with `ruthg@simple.biz` (Accounting, ₱260/₱390) for the May 31–Jun 6 week:

| Logic | Hours | Initial Pay | Note |
|---|---|---|---|
| Old (`resolveToPayWeek`) | 42.36h | ₱11,320.40 | paid Jun 7 mislabeled as May 31 |
| Single-file ISO fix only | 40.86h | ₱10,735.40 | correct boundary, but lost May 31 |
| **ISO + cross-upload merge** | **42.11h** | **₱11,222.90** | May 31 (1:15) recovered, Jun 7 excluded ✅ |

This still depends on the prior week's upload being archived (it normally is). It does **not**
recover a Sunday that no upload resolves to (the original May-10 case) — that still needs the
additive backfill for the calendar.
